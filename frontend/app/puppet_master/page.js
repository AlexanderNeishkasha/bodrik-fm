"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ui } from "../lang/ru";
import Toast from "../studio/components/Toast";
import AdminUserCard from "./components/AdminUserCard";
import useAdminUsers from "./hooks/useAdminUsers";
import styles from "./AdminPage.module.css";

/** Render admin users while the focused hook owns authorization and mutations. */
export default function AdminPage() {
  const admin = useAdminUsers();

  return (
    <div className={`${styles.screen} hero-bg min-h-screen text-[var(--theme-text)]`}>
      <div className={`${styles.shell} mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-14`}>
        <header className="flex items-center justify-between">
          <Link
            href="/"
            aria-label={ui.main.backToRooms}
            title={ui.main.backToRooms}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--theme-accent)] transition hover:-translate-y-[1px] hover:text-[var(--theme-accent-bright)] active:scale-95"
          >
            <ArrowLeft aria-hidden="true" className="h-6 w-6" strokeWidth={2.4} />
          </Link>
          <button
            type="button"
            onClick={admin.logout}
            className="btn-accent inline-flex h-8 items-center justify-center rounded-full bg-[var(--theme-accent)] px-4 text-xs font-semibold uppercase leading-none tracking-[0.2em] text-[var(--theme-text-dark)]"
          >
            Выйти
          </button>
        </header>

        {admin.status === "loading" ? <p>Загрузка...</p> : null}
        {admin.status === "unauthorized" ? <p>Сначала войдите в аккаунт.</p> : null}
        {admin.status === "forbidden" ? <p>Доступ только для администратора.</p> : null}
        {admin.status === "error" ? <p>Ошибка загрузки данных.</p> : null}

        {admin.status === "ready" ? (
          <div className={`${styles.users} space-y-3`}>
            {admin.users.map((user) => (
              <AdminUserCard
                key={user.id}
                user={user}
                password={admin.passwordDrafts[user.id] || ""}
                room={admin.roomDrafts[user.id] || ""}
                listed={Boolean(admin.listedDrafts[user.id])}
                conferenceAllowed={Boolean(user.conference_allowed)}
                conferenceBusy={Boolean(admin.conferenceBusyByUser[user.id])}
                passwordBusy={Boolean(admin.passwordBusyByUser[user.id])}
                deleteBusy={Boolean(admin.deleteBusyByUser[user.id])}
                onPasswordChange={(value) => admin.setPasswordDrafts((current) => ({
                  ...current,
                  [user.id]: value,
                }))}
                onResetPassword={() => admin.resetPassword(user.id)}
                onRoomChange={(value) => {
                  admin.setRoomDrafts((current) => ({ ...current, [user.id]: value }));
                  admin.scheduleRoomUpdate(user.id);
                }}
                onListedChange={(value) => {
                  admin.setListedDrafts((current) => ({ ...current, [user.id]: value }));
                  admin.scheduleRoomUpdate(user.id);
                }}
                onConferenceAccessChange={(value) => admin.updateConferenceAccess(user.id, value)}
                onDelete={() => admin.deleteUser(user.id)}
              />
            ))}
          </div>
        ) : null}
      </div>
      <Toast notice={admin.notice} />
    </div>
  );
}
