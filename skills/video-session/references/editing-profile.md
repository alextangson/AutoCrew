# 工作区剪辑方案的采用

AutoCrew 的写稿、交接、认领和批准仍由服务管理；具体剪辑工艺及审美使用创作者工作区登记的制作包。不要把某位创作者的个人 IP、字体或母本设为所有账号默认。

1. 先从服务取得当前项目绑定、交接和认领，读取项目 AGENTS.md 所指的工作区制作入口。
2. 有项目 `00-project/notes/production-adoption.json` 时沿用它；首次采用才读取工作区 `production/adopted-profile.json`。没有记录则沿用原工作区规则，缺少视觉资产时报告，不猜 broll 路径。
3. 采用记录中的 `manifest_path` 相对当前资料库根，位于 shared-assets。核对 library_id/workspace_id、manifest_sha256 和清单内每个文件的 SHA-256。可使用已安装 personal-ip-video-loop 的 `scripts/verify_production_profile.py --library <资料库> --adoption <采用记录>`。冻结包包含自己的规则、Skills 和视觉参考；插件运行时与账号不打包。
4. 首次剪辑时由已认领 Codex 将采用记录原字节保存到项目允许写入的 `00-project/notes/production-adoption.json`，通过 autocrew_video report 记录该文件哈希。不要写 AutoCrew 生成的 workflow-state.json，不改交接包 manifest，不因此推进状态或审批。
5. 先读包清单的 rules，再读 entrypoint；视觉、Logo、角色路径以包内镜像根为准。approval 状态随原始母本保留，复制不等于批准。
6. 默认包更新只用于后续首次采用。已开工项目继续使用固定版本，除非用户明确要求切换。升级建新版本、校验后切换采用记录；原包继续保留供现有工程恢复。GitHub 的 Skills 备份更新不等于工作区自动升级。

人工最新草稿、文稿不可变性、真实四道闸门与费用权限优先于独立 Skill 的默认建目录/写状态操作。工作区文件按次读取，无需为读取这些规则重启服务。
