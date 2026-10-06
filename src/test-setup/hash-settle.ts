/**
 * 大多数测试刚写完文件就对账 / 决定：把「一分钟内改过算还在写」的窗口关掉。
 * 用环境变量而不是 import hash-cache：setup 先 import 会让测试文件里对 manifest 的 vi.mock 失效。
 * 专门测这条规则的用例自己用 setSettleMs(60_000) 打开（见 hash-cpu.test.ts）。
 */
process.env.AUTOCREW_TEST_SETTLE_MS = "0";
