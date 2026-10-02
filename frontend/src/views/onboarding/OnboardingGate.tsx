/**
 * 首次开机的引导页外面套一层（e2e 1002b N4）：更新的结果——成功、失败、需要手动恢复——在引导页上面也要看得见，
 * 不能被引导挡住（弹窗是 position:fixed、z-index 1000，盖在引导之上）。
 * 「有新版本」的横幅不放这里：它等引导结束、回到看板再出现。
 */
import type { ComponentProps } from "react";
import { Onboarding } from "../Onboarding";
import { UpdateResultDialog } from "../update/UpdateResultDialog";

export function OnboardingGate(props: ComponentProps<typeof Onboarding>) {
  return <>
    <Onboarding {...props} />
    <UpdateResultDialog />
  </>;
}
