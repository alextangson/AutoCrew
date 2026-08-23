# 三平台创作者后台端点规格（初版，未经真实抓包）

> 状态：来自公开开源仓库源码的初版规格 · 2026-08-23。**全部待真实抓包校准**（spec §4.2 的 spike 交付物之一）。标「未确认」的项第一轮联调优先验证。schema 守卫按本文件字段名先写，不符即 `schema_changed` 零写入。

## 传输策略总表（决定各抓取器的形态）

| 平台 | 通道 | 原因 |
|---|---|---|
| 抖音 | **CDP 网络拦截**：开作品管理页，旁听页面自己发的 JSON 响应 | 强风控：接口带 `msToken`/`a_bogus` 签名，in-page 裸 fetch 也可能缺参被打回（`status_code:8`） |
| 视频号 | in-page fetch（cookie 直连，无签名） | `mmfinderassistant-bin` 系纯 Cookie + 固定 header |
| 小红书 | in-page fetch + 页面内 `window._webmsxyw` 签名；先试免签旧端点 | 部分端点需 x-s/x-t/x-s-common，一次性签名不可重放 |

## 1. 抖音 creator.douyin.com

端点（两套并存，社区仓库互相矛盾，抓包时都试）：

| URL | Method | 参数 | 备注 |
|---|---|---|---|
| `/web/api/creator/item/list` | GET | `count`(≤50), `order_by=1`, `fields=metrics,review,visibility`, `need_cooperation=true`, `need_long_article=true`, `max_cursor` | 现行主路（2026-08 实测来源标注旧路已失效） |
| `/janus/douyin/creator/pc/work_list` | GET | `page_size`(20–50), `status`(0/1/3), `max_cursor`（`page_num` 服务端忽略） | 旧路，部分仓库仍在用；Referer `creator-micro/content/manage` |
| `/janus/douyin/creator/data/item_analysis/metrics_trend` | POST | `{aweme_id, start_time, end_time, metrics:[...]}` | 单作品趋势；**响应结构未确认** |
| `/aweme/janus/creator/data/overview/all/` | GET | 未确认 | 账号 7 日总览 |
| `/web/api/media/user/info/?aid=1128` | GET | — | 登录判定 |

响应要点：

- `item/list`: `items[].id`（**JSON number，JS 解析丢精度——必须按原始文本取或 BigInt**）、`.description`、`.create_time`（Unix 秒，字符串）、`.type`(4=视频)、`.metrics.*`（**全为字符串**）：`view_count`/`like_count`/`comment_count`/`share_count`/`favorite_count`/`completion_rate`/`completion_rate_5s`/`avg_view_second` 等；翻页 `has_more` + `max_cursor`。
- `work_list`: `aweme_list[].{aweme_id, desc, item_title, create_time, statistics{play_count,digg_count,comment_count,share_count,collect_count}}`；顶层 `items[]` 与 `aweme_list[]` 按索引对应，率类指标在 `items[].metrics`。
- 统一信封 `status_code != 0` 报错；`status_code: 8` = 未登录/风控。
- 登录正向证据：`/web/api/media/user/info/?aid=1128` 响应含 `user_info`/`user`。DOM 兜底：页面文本「扫码登录」=未登录，「数据概览/作品数据」=已登录（URL/title 不可靠）。

来源：olo-dot-io/Uni-CLI `src/adapters/douyin/*.ts`；jackwener/OpenCLI `clis/douyin/*.js`；diamondfsd/douyin-data-analysis-skill；liuhongtao1981/HISCRM-IM-Portal 作品统计API分析。

## 2. 视频号 channels.weixin.qq.com

全部 **POST + JSON body**，前缀 `/cgi-bin/mmfinderassistant-bin`（或 `/micro/content/cgi-bin/…`）。无签名，纯 Cookie（关键字段 `sessionid`）。

| 路径 | body 参数（公共体之外） | 用途 |
|---|---|---|
| `/auth/auth_data` | 无 | 登录判定 + 拿 `finderUsername` |
| `/post/post_list` | `pageSize`, `currentPage`, `userpageType`(取值 3/13/0/10/11 各仓库不一，**未确认**), `forMcn:false`, `needAllCommentCount:true`, `onlyUnread:false` | 作品列表（含指标） |
| `/statistic/new_post_total_data` | `startTs`, `endTs`(秒), `interval:3` | 账号按日总量 |
| `/helper/helper_upload_params` | 无 | 拿 `data.uin`（填 `X-WECHAT-UIN` header） |

- 公共 body：`timestamp`(毫秒字符串), `_log_finder_uin:""`, `_log_finder_id`(=finderUsername), `rawKeyBuff:""`, `pluginSessionId:null`, `scene:7`, `reqScene:7`
- query：`_aid`, `_rid`(随机), `_pageUrl`(与前端页面一致)
- header：`X-WECHAT-UIN`（未取到填 `"0000000000"`）, `finger-print-device-id`(随机), Referer 如 `/platform/post/list`

响应：`{errCode:0, errMsg, data:{list:[], totalCount}}`。`list[]` 字段（来源为真实抓包留痕的类型定义，可信度最高）：`objectId`/`exportId`、`createTime`(秒)、`readCount` 播放、`likeCount`、`commentCount`、`forwardCount`、`favCount` 收藏、`followCount` 涨粉、`fullPlayRate` 完播率、`avgPlayTimeSec`、`visibleType`、标题在 `desc.description` 与 `desc.shortTitle[0].shortTitle`。

登录判定：POST `/auth/auth_data`，`errCode === 0` 且能取到 `finderUsername` = 在线。

来源：liuxuehao/weixinshipinhao_publisher `channels_publisher.py`；yikart/AiToEarn `plat/shipinhao/`（响应类型最全）；3441293738/creatorhub。

## 3. 小红书 creator.xiaohongshu.com

| URL | Method | 参数 | 签名 |
|---|---|---|---|
| `/api/galaxy/creator/datacenter/note/analyze/list` | GET | `type=0`, `page_size`(10–20), `page_num` | 有仓库用裸同源 fetch 未加签名（**是否免签未确认**） |
| `/api/galaxy/creator/data/note_stats/new` | GET | `page`, `page_size`, `sort_by=time`, `note_type`(0/1/2), `time`(7/30) | **需 x-s/x-t/x-s-common**，签名一次性不可重放 |
| `/api/galaxy/creator/note/user/posted`（旧） | GET | `tab`, `page` | 旧版免签，可当登录 ping |
| `/api/galaxy/v2/creator/note/user/posted` | GET | `tab`, `page`（`data.page` 为下一页游标，`-1` 结束） | 需签名 |
| `/api/galaxy/user/info` | GET | — | 登录判定 |

- 必带 Referer（如 `https://creator.xiaohongshu.com/new/note-manager`）。
- 签名：页面内 `window._webmsxyw(uri, data)` → `{X-s, X-t}` 映射到 header `x-s`/`x-t`；`uri` 为含 query 的路径。`x-s-common` 需本地拼 base64 JSON（ReaJason/xhs `help.py` 有纯实现）。首次调用常报 `_webmsxyw is not a function`，需重试。
- 响应：统一信封 `{success, code, msg, data}`；`note_infos[]`: `id`(note_id)、`title`、`post_time`(**毫秒**)、`read_count` 观看、`like_count`、`fav_count`、`comment_count`。**未发现曝光/完播字段**（曝光未确认）。
- 风控：HTTP 461/471 = 验证码（响应头 `Verifytype`/`Verifyuuid`）→ `risk_control`。
- 登录判定：先打免签旧 `posted` 或 `user/info`；`success:false`/`code:-1` 在签名端点上区分不了「未登录」和「签名失败」，判登录必须用免签端点。

来源：ReaJason/xhs `xhs/core.py` L741–779、`help.py`、issue #153；olo-dot-io/Uni-CLI `_creator-notes-data.ts`；cv-cat/Spider_XHS；unzoa/xhs-creator-chrome-extension。

## 跨平台注意

1. 完播率：视频号 `fullPlayRate`、抖音 `completion_rate` 有；小红书没有。
2. 抖音 `metrics` 数值全是字符串、item id 会丢精度——解析层统一处理。
3. 指标映射到 `OutcomeMetrics`：views ← 播放/观看（douyin view_count·play_count / 视频号 readCount / xhs read_count）；impressions 三平台初版均无可靠来源（xhs 曝光未确认，先不映射）。
4. Referer 是 fetch 的 forbidden header，代码里设了也会被浏览器静默丢弃；in-page 路线由页面 URL 自动带，无需也无法手工设置。

## 真实抓包校准优先级（联调 checklist，按风险排序）

实现阶段（2026-08-23）抓取器已按本文件落地并以 fixture 锁契约，以下各项在创始人登录后台后的首轮联调中**按序验证**：

1. **完播率量纲**（最高优先）：`completion_rate` / `fullPlayRate` 是 0-1 还是 0-100 三平台均无来源。当前归一规则「≤1 视为比例 ×100」有明知代价：真实 0.8% 会被放大成 80%——这是唯一会产出「看起来正常但是错」的数字的地方。
2. **抖音双数组索引配对**：旧路 `items[]` 与 `aweme_list[]` 按索引对应且无 id 交叉校验，长度/顺序不一致会把率类指标静默挂错作品。优先确认两数组是否都带 id，能 id 配对就换掉索引配对。
3. **视频号 `userpageType`**：取值各仓库不一（当前取 3）。取错的表现不是报错而是 `ok + 0 行`——schema 守卫拦不住「合法但为空」，联调时对照后台真实作品数。
4. **小红书 `analyze/list` 与 `note_stats/new` 是两个端点**，本文件把响应合并描述了；实际 schema 很可能不同，fixture 按同构构造，差异需逐字段校准。另确认 `user/info` 是否免签（当前当免签主路用，若需签名，登录判定会退化成 schema_changed）。
5. 抖音新旧两路（`item/list` vs `work_list`）哪条实际存活；`metrics_trend` 响应结构。
6. 视频号 `finderUsername` 的真实路径（当前认 4 条常见路径）。
7. x-s-common 是否必需（当前未拼，等 x-s/x-t 确认不够用再补）。
