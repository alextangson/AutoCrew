# 英文版制作做法（前台步骤）

全媒体 spec §3.3 的标准做法，2026-10-23 demo 验证、创始人认可。**这一步在前台会话里做，不派后台 Codex**：ChatCut 的付费生成只有 ChatCut 窗口开着、有人确认时才放行（不开窗口会被自动拒），后台 Codex（审批策略 never）跑不了；一个 ChatCut 项目同一时间只接一个 MCP 客户端。开工前确认创始人在、能点确认；每次付费生成前先报价。

动 ChatCut 前按仓库 CLAUDE.md 拿锁（`mkdir ~/.cache/autocrew-yt/chatcut.lock`），这一段做完或要问创始人前放锁；写操作带明确的轨道 / item ID。

## 前提（产品核过才往下走）

- 英文脚本已在「等你拍板」里批过：`autocrew_content {action:"en_edition", content_id:<英文版>, edition:{op:"status"}}` 的 `approval` 是「已批准」。
- ElevenLabs 配好了：创始人在「AutoCrew 设置 → 接入更多 → 英文版配音（ElevenLabs）」里填了 API Key 和克隆声音的 Voice ID（都不回显，只显示已配置 / 掩码；环境变量 ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID 优先）。`dub` 回 `elevenlabs_key_missing` / `elevenlabs_voice_missing` 就请他去那里填，`status` 里会一直显示「配音失败：…」直到下一次配成功。
- 源视频登记了无字幕母版：剪辑方对源视频 `record kind=clean_master captions_off=true`（绑审过的成片、1920×1080、有音轨、时长对得上）。没登记时 `dub` 回 `no_clean_master`，照回执的 `next_action` 请剪辑方导出并登记，不要拿带字幕的成片顶。
- 配音已出、没被拒：`edition:{op:"dub"}` 回 `ok:true`，拿到 `manifest_path`、`tail_slowdown`、`slow_from_s` 和 `picture_source`（无字幕母版的绝对路径——下面所有画面都从它来）。回 `overrun_too_long` 就回去把脚本写短、重新请创始人批，不硬放慢；回 `tts_failed` 把原话告诉创始人（不换声音、不换 TTS）。

## 步骤

1. **摆音轨**：按清单 `lines[]` 的 `startS` 把每段 mp3 放上去（清单保证顺排、间隔 ≥0.15 秒、不早于时间槽，不要自己挪）。
2. **画面重排时**（画面 = `picture_source` 的无字幕母版）：`tail_slowdown` > 1 时，从 `slow_from_s` 到结尾把画面放慢这个倍数（≤1.15，清单已核过）；口型对齐的脸上**不放定格帧**。原中文音轨按同一倍数 atempo 一起放慢——口型对齐的服务要参考视频里带原始人声。
3. **口型对齐参考视频**：导出重排后的画面 + 原中文人声，**小于 50 MiB**（超了先降码率再导）。没有音轨会被拒（demo 里第一次就因为「video has no audio track」失败）。
4. **口型对齐**：ChatCut `submit_lipsync`，模式 `preserve-video`，参考视频 = 第 3 步那份，音频 = 第 1 步排好的英文配音。只对 A-roll 口播段；先报价，创始人确认后再提交。
5. **MG / 字卡**：中文字的 MG 卡按英文重做（ChatCut MG 是代码）；B-roll 里的中文截图保留，加英文说明条。
6. **字幕（style A）**：`edition:{op:"captions"}` 生成 cues（文字只取批过的脚本，时间取配音的字级时间戳），再按回执的 `burn_command` 跑 `sidecars/captions/burn_captions.py`（路径已加单引号；把 `<…>` 两处换成真实路径时也加单引号——项目路径里有空格和中文）。成片要带音轨（英文配音），没有音轨脚本会直接拒。字幕样式：Avenir Next Demi Bold 54px、白字、柔和深色阴影、底部居中最多两行、每条最多一个黄色关键词、整条一起出一起收。脚本拒绝的 cue（三行、两个关键词、重叠、超长）不要手改 JSON 绕过，回去改脚本或分条。
7. **登记与审片**：英文成片和中文成片走同一套审片——对英文版这条稿 `autocrew_content record kind:cut`（字幕 `kind:srt` 绑这版成片）、`mark_ready`，再 `autocrew_review_inbox list` 把成片那件给创始人看。**他必须亲耳听**：克隆声音是最大风险，嘴型（牙齿、糊）也在这里抓。登记口型对齐用的参考视频时记成这条稿的 `kind:aroll`（制作段要它）。
8. **英文发布包**：成片审过、缩略图和各平台发布包都齐了以后，由创始人在「等你拍板」里批一次英文发布包，见 SKILL.md 英文版第 7 步。

## 源视频成片换版之后（rebind）

拒绝原因里说「源视频换了一版成片……用 rebind」时：

1. `edition:{op:"rebind"}`：英文版绑到新成片。中文没变的段原样留着（英文、换例、标黄词），时间槽换成新成片的；中文变了 / 新加的段在对照页和 `problems` 里标「成片换版」；缩略图留着；脚本批准撤掉，稿子回到「等你拍板」。英文版这一轮的英文成片、口型参考片转入历史（画面换了）。
2. 把回执的 `diff_lines`（旧 / 新成片逐句对比）给创始人看；按新中文核标出来的段，`op:"source"` 拿新时间槽，重交 `set_script`（没变的段原样交），他重批。
3. `op:"dub"`：只有英文变了的段会真去调 ElevenLabs（每段按文字缓存，没变的复用）。
4. **口型对齐和字幕必须在新成片上重做**：从上面的第 1 步摆音轨起重走一遍（参考视频用新成片导），`captions` 重出、重烧；英文成片重新登记、创始人重审；发布包按新的脚本 / 配音重交、重批。
5. 不要删稿重派生，也不要拿旧的英文成片顶。

## 记下来的坑

- 默认声音参数听起来像播音员；用 settings 里的 stability 0.3 / similarity 0.8 / style 0.35 / speaker boost。
- 下一步改进：用一段自由说话的英文录音重新克隆，比念稿克隆自然。
