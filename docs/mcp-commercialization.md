# AutoCrew MCP 产品化边界

AutoCrew 使用同一 Capability Registry 服务 OpenClaw、stdio MCP、HTTP MCP 与 CLI。

## 本地版

- `autocrew mcp`：stdio MCP，使用本地 `~/.autocrew` 数据。
- `http://127.0.0.1:4317/mcp`：Streamable HTTP 请求端点，使用本地 Bearer Token。
- 用户自备模型 Key，数据默认不离开本机。

## 商业远程版

云端部署复用 `handleMcpRequest(request, access)`，在接入层提供：

1. OAuth/JWT 验证，并映射为 `McpPrincipal`。
2. `authorize`：按套餐、工作区和工具授权。
3. `recordUsage`：记录工具、耗时与成功状态，交给计费系统聚合。
4. 每个租户独立的数据目录或对象存储命名空间。
5. 发布类不可逆工具继续要求显式确认和短时授权票据。

支付供应商、OAuth 身份供应商和云数据库不属于本地核心，不在仓库中硬编码。
