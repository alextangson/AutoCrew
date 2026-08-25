#!/usr/bin/env python3
"""AutoCrew ASR sidecar —— FunASR Paraformer 中文转写 + 字级时间戳（设计 spec §4.3）。

契约（调用方是 src/modules/video/asr.ts，改这里等于改协议）：

    uv run --project sidecars/asr sidecars/asr/asr.py --audio <绝对路径> --out <绝对路径> [--hotword "词1 词2"]
    uv run --project sidecars/asr sidecars/asr/asr.py --warmup

  * `--out` 落一份 JSON，逐字段对齐 TS 侧的 `VideoTranscript`：
      {"schemaVersion":1,"source":"funasr",
       "segments":[{"id":"seg-0001","text":"…","startMs":0,"endMs":1200,
                    "words":[{"w":"你","startMs":0,"endMs":120}]}]}
    `scriptAlignment` 由 TS 侧算（口播稿在主进程里），python 不碰。
  * `--hotword` 可选，空格分隔的热词表，原样透传给 `model.generate(hotword=...)`
    （所用的 SeACo-Paraformer 就是 FunASR 的热词定制模型，原生支持）。**不传 = 缺省行为
    逐字节不变**——热词是可选增强，不是新的必填协议。词表由 TS 侧从口播稿正文里抽
    （src/modules/video/hotwords.ts）。
  * 进度与告警一律走 stderr；stdout 保持干净。
  * 退出码即状态：0 成功｜2 入参不对｜20 模型未就绪（调用方据此落 blocked: asr_not_ready）｜1 其余失败。

三条纪律：

1. **转写路径绝不下载模型**。首跑 ~1GB 的下载只发生在 `--warmup`；转写时模型不在本地就
   直接退 20，让调用方给出「去预热」的人话指引——而不是让一次点击悄悄卡在下载上 20 分钟。
2. **不做文本规范化**。识别出什么就写什么（标点由 ct-punc 给），大小写/数字/错别字都不改：
   规范化是有损的，一旦写进不可变的 transcript 就再也回不去了。
   `--hotword` 不破这条纪律：热词是**解码期的识别偏置**（改的是模型认出什么），不是拿规则
   去改模型认出来的结果——后处理才有损，偏置没有。
3. **输出原子落盘**（tmp + os.replace）。半个 JSON 比没有 JSON 更难查——调用方读到半文件
   只能报「转写产物损坏」，那本可以避免。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_BAD_INPUT = 2
EXIT_MODEL_NOT_READY = 20

# 模型可用环境变量覆盖（换模型是运维动作，不该改代码）
ASR_MODEL = os.environ.get("AUTOCREW_ASR_MODEL", "paraformer-zh")
VAD_MODEL = os.environ.get("AUTOCREW_ASR_VAD_MODEL", "fsmn-vad")
PUNC_MODEL = os.environ.get("AUTOCREW_ASR_PUNC_MODEL", "ct-punc")

# FunASR 短名 → ModelScope 仓库名。只用于「本地缓存在不在」的预检；
# 短名不在表里（用户自定义模型）时跳过预检，交给 FunASR 自己报错。
MODEL_REPOS = {
    "paraformer-zh": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "fsmn-vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
}

# 一个「词」= 一个汉字，或一串连续的拉丁字母/数字（Paraformer 的 token 粒度就是这样）。
# 标点与空白不占时间戳，对齐时跳过。
#
# **这个口径是双侧契约**：TS 侧的清洗（src/modules/video/transcript-clean-align.ts）要按同样的
# 规则把改后的文字切回词，两边差一个字符，词与时间戳就整体错位一格。样本与期望落在
# word-units.contract.json，TS 的测试会同时验两侧——改这行正则先去那里加样本。
WORD_UNIT_RE = re.compile(r"[A-Za-z0-9']+|[^\s\W_]", re.UNICODE)


def log(message: str) -> None:
    print(f"[asr] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# 模型缓存预检（纪律 1）
# --------------------------------------------------------------------------


def modelscope_cache_roots() -> list[Path]:
    """ModelScope 各版本的缓存布局都覆盖到——判「已下载」宁可宽松，也不误报未就绪。"""
    base = Path(os.environ.get("MODELSCOPE_CACHE", Path.home() / ".cache" / "modelscope"))
    return [base / "hub" / "models", base / "hub", base / "models", base]


def model_cached(name: str) -> bool:
    repo = MODEL_REPOS.get(name)
    if repo is None:
        return True  # 自定义模型名：无从判断，放行
    # 新版 modelscope 把 org/name 扁平成 org--name 落盘，两种形态都认
    candidates = (repo, repo.replace("/", "--"))
    return any((root / c).is_dir() for root in modelscope_cache_roots() for c in candidates)


def missing_models() -> list[str]:
    return [name for name in (ASR_MODEL, VAD_MODEL, PUNC_MODEL) if not model_cached(name)]


# --------------------------------------------------------------------------
# 结果整形
# --------------------------------------------------------------------------


def to_ms(value: Any, fallback: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return fallback


def pair_words(text: str, timestamps: Any) -> list[dict[str, Any]]:
    """把 FunASR 的 token 时间戳对回文本单元。

    时间戳是「识别 token」的，文本是「加了标点」的——两者按顺序一一对应，
    标点不占 token。数量对不上时取短的一侧并告警：**宁可少几个词的字幕，
    也不要把时间戳错位一格**（错位的逐词高亮比没有高亮更糟）。
    """
    if not isinstance(timestamps, list):
        return []
    units = WORD_UNIT_RE.findall(text or "")
    if len(units) != len(timestamps):
        log(f"警告：文本单元 {len(units)} 个、时间戳 {len(timestamps)} 个，按较短的一侧对齐")
    words: list[dict[str, Any]] = []
    for unit, span in zip(units, timestamps):
        if not isinstance(span, (list, tuple)) or len(span) < 2:
            continue
        start = to_ms(span[0])
        end = to_ms(span[1], start)
        words.append({"w": unit, "startMs": start, "endMs": max(start, end)})
    return words


def segment_from(index: int, text: str, start: Any, end: Any, timestamps: Any) -> dict[str, Any]:
    words = pair_words(text, timestamps)
    start_ms = to_ms(start, words[0]["startMs"] if words else 0)
    end_ms = to_ms(end, words[-1]["endMs"] if words else start_ms)
    return {
        "id": f"seg-{index:04d}",
        "text": text,
        "startMs": start_ms,
        "endMs": max(start_ms, end_ms),
        "words": words,
    }


def build_segments(result: dict[str, Any]) -> list[dict[str, Any]]:
    """优先用 sentence_info（VAD 分句 + 句级时间轴已拼回全局）；没有就整条当一句。"""
    sentences = result.get("sentence_info")
    if isinstance(sentences, list) and sentences:
        return [
            segment_from(i, str(s.get("text", "")), s.get("start"), s.get("end"), s.get("timestamp"))
            for i, s in enumerate(sentences, start=1)
            if isinstance(s, dict)
        ]
    log("警告：结果里没有 sentence_info，整条音频按单句输出")
    text = str(result.get("text", ""))
    if not text:
        return []
    return [segment_from(1, text, None, None, result.get("timestamp"))]


def write_transcript(out_path: Path, segments: list[dict[str, Any]]) -> None:
    """tmp + replace：崩在写一半也不会留下半个 JSON（纪律 3）。"""
    payload = {"schemaVersion": 1, "source": "funasr", "segments": segments}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(out_path.parent), prefix=out_path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, out_path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def load_model(allow_download: bool):
    from funasr import AutoModel  # 导入要 ~10 秒，放在预检之后

    log(f"加载模型 {ASR_MODEL} + {VAD_MODEL} + {PUNC_MODEL}（首跑需下载约 1GB）…")
    return AutoModel(
        model=ASR_MODEL,
        vad_model=VAD_MODEL,
        punc_model=PUNC_MODEL,
        # 每次启动都去查版本会让离线环境卡住，且我们本就固定模型版本
        disable_update=True,
        disable_pbar=not allow_download,
        device=os.environ.get("AUTOCREW_ASR_DEVICE", "cpu"),
    )


def do_warmup() -> int:
    load_model(allow_download=True)
    log("模型就绪")
    return EXIT_OK


def do_transcribe(audio: Path, out: Path, hotword: str | None = None) -> int:
    model = load_model(allow_download=False)
    if hotword:
        log(f"热词偏置：{hotword}")
    log(f"转写中：{audio.name}")
    results = model.generate(
        input=str(audio),
        # 长音频先由 fsmn-vad 切段再批量识别；300 秒一批是 FunASR 的推荐量级
        batch_size_s=300,
        sentence_timestamp=True,
        # 没热词就一个字都不多传：空串/空表在各版本 FunASR 里的语义不一致，
        # 而「不传热词」必须与热词功能上线前逐字节等价（调用方靠这条判断结果可复用）
        **({"hotword": hotword} if hotword else {}),
    )
    if not results:
        log("识别结果为空（可能是纯音乐或全程静音）")
        write_transcript(out, [])
        return EXIT_OK
    segments = build_segments(results[0] if isinstance(results[0], dict) else {})
    write_transcript(out, segments)
    log(f"完成：{len(segments)} 句 / {sum(len(s['words']) for s in segments)} 词 → {out}")
    return EXIT_OK


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AutoCrew ASR sidecar（FunASR Paraformer 中文）")
    parser.add_argument("--audio", help="输入音频/视频绝对路径")
    parser.add_argument("--out", help="转写结果 JSON 的输出绝对路径")
    parser.add_argument("--hotword", help="空格分隔的热词表（识别期偏置）；不传则行为与今天一致")
    parser.add_argument("--warmup", action="store_true", help="只下载/加载模型然后退出")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if args.warmup:
        return do_warmup()

    if not args.audio or not args.out:
        log("缺少参数：转写模式需要 --audio 与 --out（预热用 --warmup）")
        return EXIT_BAD_INPUT
    audio = Path(args.audio)
    if not audio.is_file():
        log(f"音频文件不存在：{audio}")
        return EXIT_BAD_INPUT

    if os.environ.get("AUTOCREW_ASR_ALLOW_DOWNLOAD") != "1":
        missing = missing_models()
        if missing:
            log(f"模型尚未下载：{'、'.join(missing)}；请先跑一次 --warmup（约 1GB）")
            return EXIT_MODEL_NOT_READY

    return do_transcribe(audio, Path(args.out), args.hotword)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        log("已中断")
        sys.exit(EXIT_FAILED)
    except Exception as err:  # noqa: BLE001 —— 出口只有一个，原因必须落到 stderr
        log(f"失败：{type(err).__name__}: {err}")
        sys.exit(EXIT_FAILED)
