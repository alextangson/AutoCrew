/**
 * 登录墙 / 风控页的通用特征（正则源码，交给 ego 子进程判定）。
 * 文字特征只在「等不到数据响应」时才看（避免作品标题里碰巧有这些字误判）；URL 特征每秒看一次。
 * 风控先于登录判：碰到就立刻停手关页，不尝试绕过。
 */
export const RISK_URL_COMMON = "captcha|verifycenter|/verify\\b|security-check|antispam";
export const RISK_TEXT_COMMON =
  "请完成(安全)?验证|安全验证|人机验证|滑块|拖动.{0,8}(滑块|拼图|完成)|操作(过于)?频繁|访问(过于)?频繁|环境异常|captcha";
export const LOGIN_TEXT_COMMON = "扫码登录|手机号登录|请先登录|登录后查看|使用账号登录|微信扫一扫登录";
