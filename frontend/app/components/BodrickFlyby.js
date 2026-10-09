"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AssetImage from "./AssetImage";
import bodrickCartoon from "../assets/bodrick_cartoon.png";
import { deferEffect } from "../lib/deferEffect";
import {
  BASE_CHANCE,
  getPageBounds,
  hasExitedPage,
  pickEntry,
  pickSize,
  pickSpeed,
} from "../lib/bodrickFlybyMath";

const SIZE_MAX = 128;

export default function BodrickFlyby({
  interactionToken,
  alwaysOn = false,
  storageKey,
  disabled = false,
  onActiveChange,
}) {
  const spriteRef = useRef(null);
  const rafRef = useRef(0);
  const tickRef = useRef(null);
  const lastTimeRef = useRef(0);
  const lastTokenRef = useRef(null);
  const missesRef = useRef(0);
  const bouncesRef = useRef(0);
  const exitRef = useRef(false);
  const enteredRef = useRef(false);
  const startedRef = useRef(false);
  const flippedRef = useRef(false);
  const targetBouncesRef = useRef(2);
  const posRef = useRef({ x: 0, y: 0 });
  const velRef = useRef({ x: 0, y: 0 });
  const sizeRef = useRef(SIZE_MAX);
  const [active, setActive] = useState(false);
  const [isFlipped, setIsFlipped] = useState(false);
  const [spriteSize, setSpriteSize] = useState(SIZE_MAX);

  const setMisses = useCallback(
    (value) => {
      missesRef.current = value;
      if (storageKey && typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, String(value));
      }
    },
    [storageKey]
  );

  const stopFlight = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setActive(false);
  }, []);

  const scheduleTick = useCallback(() => {
    rafRef.current = requestAnimationFrame((now) => tickRef.current?.(now));
  }, []);

  const tick = useCallback((now) => {
    const sprite = spriteRef.current;
    if (!sprite) {
      scheduleTick();
      return;
    }

    const lastTime = lastTimeRef.current || now;
    const delta = Math.min(0.05, (now - lastTime) / 1000);
    lastTimeRef.current = now;

    const size = sizeRef.current;
    const { width, height } = getPageBounds();
    const maxX = Math.max(0, width - size);
    const maxY = Math.max(0, height - size);

    let { x, y } = posRef.current;
    let { x: vx, y: vy } = velRef.current;

    x += vx * delta;
    y += vy * delta;

    if (exitRef.current) {
      if (hasExitedPage({ x, y, size, width, height })) {
        stopFlight();
        return;
      }
    } else {
      const insideX = x >= 0 && x <= maxX;
      const insideY = y >= 0 && y <= maxY;
      if (!enteredRef.current && insideX && insideY) {
        enteredRef.current = true;
      }

      if (!enteredRef.current) {
        posRef.current = { x, y };
        velRef.current = { x: vx, y: vy };
        const facing = vx < 0 ? -1 : 1;
        sprite.style.transform = `translate3d(${x}px, ${y}px, 0) scaleX(${facing})`;
        scheduleTick();
        return;
      }

      let bounced = false;
      if (x <= 0) {
        x = 0;
        vx = Math.abs(vx);
        bounced = true;
      } else if (x >= maxX) {
        x = maxX;
        vx = -Math.abs(vx);
        bounced = true;
      }

      if (y <= 0) {
        y = 0;
        vy = Math.abs(vy);
        bounced = true;
      } else if (y >= maxY) {
        y = maxY;
        vy = -Math.abs(vy);
        bounced = true;
      }

      if (bounced) {
        bouncesRef.current += 1;
        if (bouncesRef.current >= targetBouncesRef.current) {
          exitRef.current = true;
        }
      }
    }

    posRef.current = { x, y };
    velRef.current = { x: vx, y: vy };

    const facing = vx < 0 ? -1 : 1;
    sprite.style.transform = `translate3d(${x}px, ${y}px, 0) scaleX(${facing})`;
    scheduleTick();
  }, [scheduleTick, stopFlight]);

  const startFlight = useCallback(() => {
    if (active || disabled) {
      return;
    }

    const size = pickSize();
    sizeRef.current = size;
    setSpriteSize(size);
    const entry = pickEntry(size);
    posRef.current = { x: entry.x, y: entry.y };

    const speed = pickSpeed();
    const { width, height } = getPageBounds();
    const target = { x: width * 0.5, y: height * 0.5 };

    if (entry.side === 0) {
      target.x = width * (0.3 + Math.random() * 0.4);
      target.y = height * Math.random();
    } else if (entry.side === 1) {
      target.x = width * (0.3 + Math.random() * 0.4);
      target.y = height * Math.random();
    } else if (entry.side === 2) {
      target.x = width * Math.random();
      target.y = height * (0.3 + Math.random() * 0.4);
    } else {
      target.x = width * Math.random();
      target.y = height * (0.3 + Math.random() * 0.4);
    }

    const dx = target.x - entry.x;
    const dy = target.y - entry.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    velRef.current = {
      x: (dx / length) * speed,
      y: (dy / length) * speed,
    };
    bouncesRef.current = 0;
    exitRef.current = false;
    enteredRef.current = false;
    targetBouncesRef.current = 2 + Math.floor(Math.random() * 2);
    flippedRef.current = false;
    setIsFlipped(false);

    lastTimeRef.current = 0;
    setActive(true);
    scheduleTick();
  }, [active, disabled, scheduleTick]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") {
      return;
    }
    const stored = window.localStorage.getItem(storageKey);
    if (stored == null) {
      return;
    }
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isNaN(parsed)) {
      missesRef.current = Math.max(0, parsed);
    }
  }, [storageKey]);

  useEffect(() => {
    if (interactionToken == null) {
      return;
    }
    if (lastTokenRef.current === interactionToken) {
      return;
    }
    lastTokenRef.current = interactionToken;
    if (active || disabled) {
      return;
    }
    return deferEffect(() => {
      const nextMisses = missesRef.current + 1;
      const chance = Math.min(1, nextMisses * BASE_CHANCE);
      if (Math.random() < chance) {
        setMisses(0);
        startFlight();
      } else {
        setMisses(nextMisses);
      }
    });
  }, [interactionToken, active, disabled, setMisses, startFlight]);

  useEffect(() => {
    if (alwaysOn && !disabled && !startedRef.current) {
      startedRef.current = true;
      return deferEffect(() => startFlight());
    }
    return undefined;
  }, [alwaysOn, disabled, startFlight]);

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(
    () => () => {
      onActiveChange?.(false);
      stopFlight();
    },
    [onActiveChange, stopFlight]
  );

  if (!active) {
    return null;
  }

  const handleFlip = (event) => {
    if (flippedRef.current) {
      return;
    }
    flippedRef.current = true;
    setIsFlipped(true);
    event.stopPropagation();
    event.preventDefault();
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-0">
      <div
        ref={spriteRef}
        className={`absolute left-0 top-0 pointer-events-auto ${
          isFlipped ? "" : "cursor-pointer"
        }`}
        onClick={handleFlip}
      >
        <AssetImage
          src={bodrickCartoon}
          alt=""
          width={spriteSize}
          height={spriteSize}
          aria-hidden="true"
          className={`bodrick-glow ${isFlipped ? "bodrick-flip" : ""}`}
          style={{ width: `${spriteSize}px`, height: "auto" }}
        />
      </div>
    </div>
  );
}
