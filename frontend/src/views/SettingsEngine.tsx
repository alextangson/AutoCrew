/**
 * 设置 · 模型（P2 spec §5.2 重写）。一页说清四件事，一个保存按钮提交整张图：
 *
 *   端点表（唯一的密钥落点） → 主端点（必填） → 备用端点（可无） → 岗位分配（默认收起）
 *
 * 三条纪律：
 * 1. **整图提交、整图校验**。四块是一份配置的四个部分，分四个按钮存就会存出
 *    「主端点指向一个刚被删掉的 id」这种半截状态；服务端也是整图校验，
 *    前端就不该假装它们互不相干。
 * 2. **删除必须说得出谁在用**（`referrersOf`）——被引用的端点删不掉，且当场列出引用者。
 * 3. **状态点来自 `engine:health`**，与顶栏横幅同一份事实；这页不自己判断线路好坏。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Field, Section } from "./settings-kit";
import { slugProviderId } from "./provider-id";
import { useEngineHealth } from "./EngineBanner";
import { ProviderTable, TestButton, TestLine, type TestState } from "./SettingsProviders";
import {
  ROLE_KEYS,
  ROLE_LABEL,
  ROLE_NOTE,
  assignmentSummary,
  providerPayload,
  referrersOf,
  splitModels,
  toProviderRows,
  type EngineAssignment,
  type EnginePointer,
  type EnginePointers,
  type ProviderRow,
  type ProviderView,
  type RoleKey,
} from "./engine-lib";

interface EngineSettingsView {
  configured: boolean;
  main?: EnginePointer | null;
  fallback?: EnginePointer | null;
  assignments?: Record<string, { provider: string; model: string; baseUrl?: string } | null>;
  providers?: ProviderView[];
  warnings?: string[];
}

const DISMISS_KEY = "engine-warnings-dismissed";
const EMPTY_ASSIGNMENTS: Record<RoleKey, EngineAssignment | null> = { writer: null, reviewer: null, scout: null, analytics: null };

/** 关掉的 warning 存浏览器，不写配置文件（spec §7「关闭状态存前端，不存文件」） */
function readDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

let providerRowSeq = 0;

/** 模型名：下拉给该端点已存的清单，也允许手打（不做 /models 自动发现，spec §2） */
function ModelInput(props: { label: string; listId: string; models: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="set-field">
      <span className="mono muted">{props.label}</span>
      <input list={props.listId} value={props.value} placeholder="模型名（可手填）" onChange={(e) => props.onChange(e.target.value)} />
      <datalist id={props.listId}>
        {props.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </label>
  );
}

function ProviderSelect(props: { value: string; rows: ProviderRow[]; noneLabel?: string; onChange: (v: string) => void }) {
  return (
    <label className="set-field">
      <span className="mono muted">端点</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.noneLabel && <option value="">{props.noneLabel}</option>}
        {props.rows.map((r) => (
          <option key={r.id || r.key} value={r.id}>
            {r.name.trim() || r.id || "未命名端点"}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EngineSection() {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [main, setMain] = useState<EnginePointer>({ provider: "", strong: "", fast: "" });
  const [fallback, setFallback] = useState<EnginePointer | null>(null);
  const [assignments, setAssignments] = useState<Record<RoleKey, EngineAssignment | null>>({ ...EMPTY_ASSIGNMENTS });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [errors, setErrors] = useState<string[]>([]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [configured, setConfigured] = useState(false);
  const { health, reload: reloadHealth } = useEngineHealth();

  const load = async () => {
    const r = await invoke("settings:get");
    if (!r.ok) return toast(r.error ?? "引擎配置读取失败");
    const d = (r as unknown as { data: EngineSettingsView }).data;
    setConfigured(d.configured);
    setRows(toProviderRows(d.providers));
    setMain(d.main ?? { provider: "", strong: "", fast: "" });
    setFallback(d.fallback ?? null);
    const next = { ...EMPTY_ASSIGNMENTS };
    for (const role of ROLE_KEYS) {
      const a = d.assignments?.[role];
      next[role] = a ? { provider: a.provider, model: a.model } : null;
    }
    setAssignments(next);
    setWarnings(d.warnings ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const pointers: EnginePointers = { main: main.provider ? main : null, fallback, assignments };
  const modelsOf = (id: string) => splitModels(rows.find((r) => r.id === id)?.models ?? "");
  const patchProvider = (key: string, patch: Partial<ProviderRow>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** 删除：被引用就拒绝，并把引用者列出来（spec §7 防呆） */
  const deleteProvider = (row: ProviderRow) => {
    const used = row.id ? referrersOf(row.id, pointers) : [];
    if (used.length) return toast(`删不了：${row.name || row.id} 正在被 ${used.join("、")} 使用——先把它们改到别的端点`);
    setRows((list) => list.filter((r) => r.key !== row.key));
  };

  const runTest = async (slot: string, providerId: string, model: string) => {
    if (!slot || tests[slot]?.status === "running") return;
    setTests((t) => ({ ...t, [slot]: { status: "running" } }));
    const r = await invoke("settings:test_route", { provider_id: providerId, model });
    reloadHealth(); // 探针结果同时进健康通道：状态点与横幅立刻跟着变
    if (!r.ok) return setTests((t) => ({ ...t, [slot]: { status: "fail", error: r.error ?? "测试失败" } }));
    const d = (r as unknown as { data: { ms: number; model: string } }).data;
    setTests((t) => ({ ...t, [slot]: { status: "ok", ms: d.ms, model: d.model } }));
  };

  /** 一次提交整张图：providers + main + fallback + assignments，服务端整图校验 */
  const saveAll = async () => {
    const taken = new Set(rows.filter((p) => p.id).map((p) => p.id));
    const withIds = rows.map((p) => {
      if (p.id) return p;
      const id = slugProviderId(p.name, taken);
      taken.add(id);
      return { ...p, id };
    });
    setRows(withIds);
    const cleanAssignments: Record<string, EngineAssignment> = {};
    for (const role of ROLE_KEYS) {
      const a = assignments[role];
      if (a?.provider && a.model.trim()) cleanAssignments[role] = { provider: a.provider, model: a.model.trim() };
    }
    const r = await invoke("settings:set", {
      providers: providerPayload(withIds),
      main,
      fallback: fallback && fallback.provider ? fallback : null,
      assignments: cleanAssignments,
    });
    if (!r.ok) {
      // 服务端的逐项错误原样摆出来，一个字不改写
      setErrors((r.error ?? "保存失败").split("；").filter(Boolean));
      return toast("没保存：下面列出了每一条不合格的地方");
    }
    setErrors([]);
    setTests({}); // 配置换了，上一次的测试结论立刻作废，不许留在屏幕上冒充现状
    toast("已保存");
    void load();
    reloadHealth();
  };

  const allWarnings = [...new Set([...warnings, ...(health?.warnings ?? [])])];
  // 同家提醒**常驻**（spec §7）：它描述的是一个仍然成立的事实,不是一次性通知,
  // 所以摆在备用端点那一格里、不给关闭按钮；其余 warning 才是顶部可关的那一批
  const sameFamily = allWarnings.filter((w) => w.includes("同一家"));
  const liveWarnings = allWarnings.filter((w) => !sameFamily.includes(w) && !dismissed.includes(w));
  const dismiss = (w: string) => {
    const next = [...dismissed, w];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下存不了：这一次关掉也算数，只是下次还会出现 */
    }
  };

  return (
    <Section title="模型 · 端点与岗位" status={configured ? "已配置" : "未配置"} on={configured}>
      <p className="muted">
        跑通「调研 → 立意 → 写稿」只要一个主端点。备用端点在主线挂掉时顶上；岗位分配是可选的加强，
        不配就全部跟随主端点。
      </p>

      {liveWarnings.map((w) => (
        <div key={w} className="engine-warn">
          <span>{w}</span>
          <button onClick={() => dismiss(w)} title="关掉这条提醒（只存在这台浏览器，不写配置文件）">
            知道了
          </button>
        </div>
      ))}
      {errors.map((e, i) => (
        <p key={`${e}-${i}`} className="mono set-test-fail">✗ {e}</p>
      ))}

      <ProviderTable
        rows={rows}
        health={health?.providers ?? []}
        pointers={pointers}
        tests={tests}
        onPatch={patchProvider}
        onAdd={() =>
          setRows((list) => [
            ...list,
            { key: `new-${(providerRowSeq += 1)}`, id: "", name: "", baseUrl: "", models: "", protocol: "", apiKey: "", apiKeySet: false, savedModels: [] },
          ])
        }
        onDelete={deleteProvider}
        onTest={(slot, id, model) => void runTest(slot, id, model)}
      />

      <p className="mono muted set-sub-head">主端点 · 对话与所有没单独分配的岗位都走它</p>
      <div className="set-route">
        <ProviderSelect value={main.provider} rows={rows} onChange={(v) => setMain((m) => ({ ...m, provider: v }))} />
        <ModelInput label="强模型" listId="main-models" models={modelsOf(main.provider)} value={main.strong} onChange={(v) => setMain((m) => ({ ...m, strong: v }))} />
        <ModelInput label="快模型" listId="main-models" models={modelsOf(main.provider)} value={main.fast} onChange={(v) => setMain((m) => ({ ...m, fast: v }))} />
        <div className="set-route-foot">
          <TestButton
            label="测强档"
            state={tests.main}
            disabled={!main.provider || !main.strong}
            title="测的是已保存的配置——改完先保存再测"
            onRun={() => void runTest("main", main.provider, main.strong)}
          />
        </div>
        <TestLine state={tests.main} />
      </div>

      <p className="mono muted set-sub-head">备用端点 · 主线失败时顶完本次调用（一个备用顶全部岗位）</p>
      <div className="set-route">
        <ProviderSelect
          value={fallback?.provider ?? ""}
          rows={rows}
          noneLabel="无（主线失败即报错）"
          onChange={(v) => setFallback(v ? { provider: v, strong: fallback?.strong ?? "", fast: fallback?.fast ?? "" } : null)}
        />
        {sameFamily.map((w) => (
          <p key={w} className="mono set-test-fail">⚠ {w}</p>
        ))}
        {fallback && (
          <>
            <ModelInput label="强模型" listId="fb-models" models={modelsOf(fallback.provider)} value={fallback.strong} onChange={(v) => setFallback((f) => (f ? { ...f, strong: v } : f))} />
            <ModelInput label="快模型" listId="fb-models" models={modelsOf(fallback.provider)} value={fallback.fast} onChange={(v) => setFallback((f) => (f ? { ...f, fast: v } : f))} />
          </>
        )}
      </div>

      <details className="engine-roles">
        <summary>
          岗位分配 · <span className="mono muted">{assignmentSummary(assignments)}</span>
        </summary>
        {ROLE_KEYS.map((role) => {
          const a = assignments[role];
          return (
            <div key={role} className="set-route">
              <div className="set-route-head">
                <span className="set-route-name">{ROLE_LABEL[role]}</span>
                <span className="mono muted set-route-now">{a ? `${a.model} · ${a.provider}` : "跟随主端点强模型"}</span>
              </div>
              <p className="muted set-route-note">{ROLE_NOTE[role]}</p>
              <ProviderSelect
                value={a?.provider ?? ""}
                rows={rows}
                noneLabel="跟随主端点"
                onChange={(v) => setAssignments((x) => ({ ...x, [role]: v ? { provider: v, model: x[role]?.model ?? "" } : null }))}
              />
              {a && (
                <ModelInput
                  label="模型"
                  listId={`role-${role}-models`}
                  models={modelsOf(a.provider)}
                  value={a.model}
                  onChange={(v) => setAssignments((x) => ({ ...x, [role]: { provider: a.provider, model: v } }))}
                />
              )}
            </div>
          );
        })}
      </details>

      <div className="set-save">
        <button className="primary" onClick={() => void saveAll()}>
          保存模型配置
        </button>
        <button
          onClick={async () => {
            const r = await invoke("settings:open_config");
            if (!r.ok) return toast(r.error ?? "打开失败");
            const d = (r as unknown as { data: { path: string; opened: boolean } }).data;
            toast(d.opened ? `已打开 ${d.path}` : `请手动打开 ${d.path}`);
          }}
        >
          打开配置文件
        </button>
        <span className="muted mono">端点表、主端点、备用、岗位一次提交；任一条不合格就整次拒绝，文件不动。</span>
      </div>
    </Section>
  );
}
