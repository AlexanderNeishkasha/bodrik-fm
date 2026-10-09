"use client";

import { useEffect, useState } from "react";

export default function PageTransition({ children }) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <div className={`page-transition${entered ? " page-transition-entered" : ""}`}>
      {children}
    </div>
  );
}
