/** 极简 toast(模块级单容器,App 挂载一次)。 */
import { useEffect, useState } from "react";

let pushToast: (msg: string) => void = () => {};

export function toast(msg: string): void {
  pushToast(msg);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    pushToast = (m) => {
      setMsg(m);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 4000);
    };
    return () => {
      pushToast = () => {};
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!msg) return null;
  return <div className="toast mono">{msg}</div>;
}
