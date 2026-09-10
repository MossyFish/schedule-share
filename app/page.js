"use client";

import { useEffect, useRef } from "react";
import { mountApp } from "./appLogic";

export default function Page() {
  const rootRef = useRef(null);

  useEffect(() => {
    if (!rootRef.current) return;
    return mountApp(rootRef.current);
  }, []);

  return <div id="app-root" ref={rootRef} />;
}
