/**
 * 团队技能（原「日志」页的标签，spec 2026-10-13 §6.3 挪进「写作手册」页）：skills/<name>/SKILL.md 全文，只读。
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { invoke } from "../transport";

interface SkillDoc {
  id: string;
  title: string;
  content: string;
}

/** SKILL.md 头部 frontmatter:description 抽出来当简介,正文走 markdown 渲染 */
export function splitSkillDoc(raw: string): { intro: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { intro: "", body: raw };
  let intro = "";
  let inDesc = false;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) {
      inDesc = kv[1] === "description";
      if (inDesc && kv[2] && !/^[|>]-?$/.test(kv[2])) intro = kv[2].trim();
    } else if (inDesc && /^\s+\S/.test(line)) {
      intro = (intro ? intro + " " : "") + line.trim();
    }
  }
  return { intro, body: raw.slice(m[0].length) };
}

export function TeamSkills() {
  const [skills, setSkills] = useState<SkillDoc[]>([]);
  const [skillId, setSkillId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke("skills:list").then((r) => {
      if (!r.ok) return setError(r.error ?? "技能列表读不了");
      const list = (r as unknown as { data: { skills: SkillDoc[] } }).data.skills;
      setSkills(list);
      setSkillId((cur) => cur ?? list[0]?.id ?? null);
    });
  }, []);

  const skill = skills.find((s) => s.id === skillId) ?? null;
  if (error) return <p className="log-bad">{error}</p>;
  return (
    <>
      <p className="muted">每份技能是一个员工的工作手册——写稿、审稿、封面、发布的行为都由它定;直接改 skills/ 下的源文件即可调教。</p>
      <div className="skills-grid">
        <div className="skill-pane">
          {skills.map((s) => (
            <button key={s.id} className={"skill-item" + (skillId === s.id ? " skill-on" : "")} onClick={() => setSkillId(s.id)}>
              <span className="skill-name">{s.title}</span>
              <span className="skill-id mono muted">{s.id}</span>
            </button>
          ))}
        </div>
        {skill && <SkillView skill={skill} />}
      </div>
    </>
  );
}

function SkillView(props: { skill: SkillDoc }) {
  const { intro, body } = splitSkillDoc(props.skill.content);
  return (
    <div>
      <div className="skill-head">
        <h3 className="serif">{props.skill.title}</h3>
        <span className="mono muted">skills/{props.skill.id}/SKILL.md</span>
      </div>
      {intro && <p className="muted skill-intro">{intro}</p>}
      <div className="md-preview skill-doc-md">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{body}</ReactMarkdown>
      </div>
    </div>
  );
}
