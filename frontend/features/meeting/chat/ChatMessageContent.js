import { projectChatContent } from "./chatContent.mjs";
import ChatRichContent, { ChatImage } from "./ChatRichContent";
import styles from "./ChatMessageContent.module.css";

/** Render untrusted retained content without HTML sinks, remote image inference or delivery/transport side effects. */
export default function ChatMessageContent({ body, origin }) {
  const content = projectChatContent(body, origin);
  if (content.type === "text") return <ChatRichContent body={body} origin={origin} />;
  return (
    <figure className={styles.figure}>
      <ChatImage key={content.src} src={content.src} origin={origin} />
      {content.caption && <figcaption className={styles.text}>{content.caption}</figcaption>}
    </figure>
  );
}
