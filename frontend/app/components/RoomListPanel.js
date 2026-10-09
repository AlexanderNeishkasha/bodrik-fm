"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useAnimatedReorder from "../lib/useAnimatedReorder";
import { getStoredValue } from "../lib/storageKeys";
import usePersistedState from "../lib/usePersistedState";

const FAVORITES_KEY = "favorite_rooms";

export default function RoomListPanel({ rooms, roomsStatus, onNavigateToRoom }) {
  const searchRef = useRef(null);
  const [searchValue, setSearchValue] = useState("");
  const [favoriteRooms, setFavoriteRooms] = usePersistedState({
    key: FAVORITES_KEY,
    defaultValue: readStoredFavoriteRooms,
    parse: parseFavoriteRooms,
    serialize: (value) => JSON.stringify(sanitizeFavoriteRooms(value)),
  });
  const sortedRooms = useMemo(() => sortRoomsByFavorites(rooms, favoriteRooms), [rooms, favoriteRooms]);
  const searchQuery = searchValue.trim().toLowerCase();
  const hasSearch = searchQuery.length >= 1;
  const visibleRooms = useMemo(() => {
    if (!hasSearch) {
      return sortedRooms;
    }
    return sortedRooms.filter((room) => room.slug.toLowerCase().startsWith(searchQuery));
  }, [hasSearch, searchQuery, sortedRooms]);
  const visibleRoomSlugs = useMemo(() => visibleRooms.map((room) => room.slug), [visibleRooms]);
  const registerRoomRow = useAnimatedReorder(visibleRoomSlugs);
  const firstVisibleRoom = visibleRooms[0];

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handleSearchKeyDown = (event) => {
    if (event.key !== "Enter" || !hasSearch || !firstVisibleRoom) {
      return;
    }
    onNavigateToRoom(event, firstVisibleRoom.slug);
  };

  const statusMessage = getStatusMessage({
    rooms,
    roomsStatus,
    hasSearch,
    visibleRooms,
  });

  return (
    <div className="grid gap-3">
      <input
        ref={searchRef}
        type="search"
        value={searchValue}
        onInput={(event) => setSearchValue(event.currentTarget.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="Найти комнату"
        aria-label="Найти комнату"
        className="w-full rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-input-bg)] px-5 py-3 text-base text-[var(--theme-text)] outline-none transition placeholder:text-[var(--theme-muted)] focus:border-[var(--theme-accent)] focus:ring-2 focus:ring-[var(--theme-accent-soft)]"
      />
      {statusMessage ? <p className="text-sm text-[var(--theme-muted)]">{statusMessage}</p> : null}
      {visibleRooms.map((room) => {
        const favorite = isFavoriteRoom(room.slug, favoriteRooms);
        return (
          <div
            key={room.slug}
            ref={(node) => registerRoomRow(room.slug, node)}
            className="panel-shadow-card-soft flex items-center gap-3 rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-card-2)] transition"
          >
            <a
              href={`/${encodeURIComponent(room.slug)}`}
              onClick={(event) => onNavigateToRoom(event, room.slug)}
              className="min-w-0 flex-1 truncate px-5 py-3 text-base"
            >
              {room.slug}
            </a>
            <button
              type="button"
              aria-label={favorite ? "Убрать из избранного" : "Добавить в избранное"}
              title={favorite ? "Убрать из избранного" : "Добавить в избранное"}
              onClick={() => setFavoriteRooms((prev) => toggleFavorite(prev, room.slug))}
              className={`mr-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-lg leading-none transition active:scale-95 ${
                favorite
                  ? "border-[var(--theme-accent)] bg-[var(--theme-accent)] text-[var(--theme-text-dark)]"
                  : "border-transparent text-[var(--theme-accent)] hover:border-[var(--theme-accent)] hover:bg-[var(--theme-ghost)]"
              }`}
            >
              ★
            </button>
          </div>
        );
      })}
    </div>
  );
}

function getStatusMessage({ rooms, roomsStatus, hasSearch, visibleRooms }) {
  if (roomsStatus === "loading") {
    return "Загрузка...";
  }
  if (roomsStatus === "error") {
    return "Не удалось загрузить список комнат.";
  }
  if (rooms.length === 0) {
    return "Пока нет комнат.";
  }
  if (hasSearch && visibleRooms.length === 0) {
    return "Ничего не найдено.";
  }
  return "";
}

function readStoredFavoriteRooms() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const stored = getStoredValue(FAVORITES_KEY);
    return stored == null ? [] : parseFavoriteRooms(stored);
  } catch {
    return [];
  }
}

function parseFavoriteRooms(value) {
  return sanitizeFavoriteRooms(JSON.parse(value));
}

function sanitizeFavoriteRooms(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized = [];
  for (const room of value) {
    if (typeof room !== "string") {
      continue;
    }
    const slug = room.trim();
    if (slug && !sanitized.includes(slug)) {
      sanitized.push(slug);
    }
  }
  return sanitized;
}

function toggleFavorite(favoriteRooms, slug) {
  if (!slug) {
    return favoriteRooms;
  }
  if (isFavoriteRoom(slug, favoriteRooms)) {
    return favoriteRooms.filter((room) => room !== slug);
  }
  return [...favoriteRooms, slug];
}

function sortRoomsByFavorites(rooms, favoriteRooms) {
  return [...rooms].sort((left, right) => {
    const leftFavorite = isFavoriteRoom(left.slug, favoriteRooms);
    const rightFavorite = isFavoriteRoom(right.slug, favoriteRooms);
    return Number(rightFavorite) - Number(leftFavorite);
  });
}

function isFavoriteRoom(slug, favoriteRooms) {
  return favoriteRooms.includes(slug);
}
