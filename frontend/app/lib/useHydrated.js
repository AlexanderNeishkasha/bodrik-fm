import { useEffect, useState } from "react";
import { deferEffect } from "./deferEffect";

export default function useHydrated() {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => deferEffect(() => setIsHydrated(true)), []);

  return isHydrated;
}
