import LegalPage from "../components/LegalPage";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "../lib/contact";

export const metadata = {
  title: "Условия использования | Бодрик FM",
  description: "Условия использования Бодрик FM.",
};

const UPDATED_AT = "15 мая 2026";

export default function TermsPage() {
  return (
    <LegalPage title="Условия использования" updatedAt={UPDATED_AT}>
      <Section title="Сервис">
        <p>
          Бодрик FM — небольшой сервис для общей музыкальной трансляции. Сервис
          предоставляется как есть, без гарантии постоянной доступности и без
          гарантии сохранности любых загруженных файлов.
        </p>
      </Section>
      <Section title="Аккаунт">
        <p>
          Вы отвечаете за безопасность своего пароля и действия в своём аккаунте.
          Администратор может ограничить доступ, удалить аккаунт или удалить
          материалы, если они нарушают эти условия или мешают работе сервиса.
        </p>
      </Section>
      <Section title="Загруженная музыка">
        <p>
          Вы отвечаете за права на музыку и файлы, которые загружаете. Не
          загружайте музыку, записи или другие материалы, если у вас нет права
          использовать и транслировать их через сервис.
        </p>
      </Section>
      <Section title="Запрещено">
        <p>
          Нельзя использовать сервис для незаконного контента, вредоносных
          файлов, спама, попыток взлома, обхода ограничений или действий, которые
          мешают другим пользователям и работе сервера.
        </p>
      </Section>
      <Section title="Ответственность">
        <p>
          Сервис может работать с перебоями, меняться или отключаться. В пределах,
          разрешённых законом, администратор сервиса не отвечает за потерю данных,
          недоступность сервиса или материалы, загруженные пользователями.
        </p>
      </Section>
      <Section title="Изменения">
        <p>
          Условия могут обновляться. Новая версия применяется после публикации на
          этой странице.
        </p>
      </Section>
      <Section title="Контакт">
        <p>
          По вопросам сервиса пишите на{" "}
          <a
            href={SUPPORT_MAILTO}
            className="underline underline-offset-4 transition hover:text-[var(--theme-accent)]"
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-[var(--theme-text)]">{title}</h2>
      {children}
    </section>
  );
}
