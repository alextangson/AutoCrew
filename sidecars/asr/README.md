# ASR sidecar（FunASR）

视频生产线的转写环节（设计 spec §4.3）。主进程只按契约 spawn 它，不 import 任何 python 代码。

## 契约

```bash
# 转写：结果写到 --out，进度/告警走 stderr，stdout 保持干净
uv run --project sidecars/asr sidecars/asr/asr.py --audio /abs/in.wav --out /abs/transcript.json

# 预热：只下载/加载模型然后退出（首跑约 1GB）
uv run --project sidecars/asr sidecars/asr/asr.py --warmup
```

退出码即状态：

| 码 | 含义 | 调用方处置 |
|---|---|---|
| 0 | 成功 | 读 `--out` |
| 2 | 入参不对（缺参数/文件不存在） | failed，可见 |
| 20 | 模型未就绪 | `blocked: asr_not_ready` + 「去预热」指引 |
| 1 | 其余失败 | failed，stderr 尾部进 run-log |

## 输出格式

逐字段对齐 TS 侧的 `VideoTranscript`（`src/modules/video/types.ts`）：

```json
{
  "schemaVersion": 1,
  "source": "funasr",
  "segments": [
    { "id": "seg-0001", "text": "今天聊聊 FDE", "startMs": 0, "endMs": 1200,
      "words": [{ "w": "今", "startMs": 0, "endMs": 120 }] }
  ]
}
```

`scriptAlignment`（与口播稿的对齐度）由 TS 侧算，python 不管——口播稿在主进程里。

## 模型

`paraformer-zh`（SeACo-Paraformer 中文，自带字级时间戳预测）+ `fsmn-vad`（长音频切段，
时间戳自动拼回全局时间轴）+ `ct-punc`（标点）。三者都可用环境变量覆盖：
`AUTOCREW_ASR_MODEL` / `AUTOCREW_ASR_VAD_MODEL` / `AUTOCREW_ASR_PUNC_MODEL`，
设备用 `AUTOCREW_ASR_DEVICE`（默认 `cpu`）。

**转写路径绝不下载模型**：模型不在 ModelScope 缓存里就直接退 20。
下载只发生在 `--warmup`——否则用户点一次「开始剪」会毫无征兆地卡 20 分钟。
要在转写时也允许下载，设 `AUTOCREW_ASR_ALLOW_DOWNLOAD=1`（不推荐，仅供排查）。

## 依赖与环境

`uv` 按 `pyproject.toml` 自建 venv（首次 `uv run` 时自动装）。
torch 是 CPU 版：macOS/Apple Silicon 的 PyPI wheel 本就没有 CUDA 变体。
Linux 上要跑需另配 `https://download.pytorch.org/whl/cpu` 索引，否则会拉 ~2GB 的 CUDA 包。
