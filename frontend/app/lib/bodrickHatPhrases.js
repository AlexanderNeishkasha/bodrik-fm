import { getStoredValue, setStoredValue } from "./storageKeys";
import { BODRICK_PHRASE_GROUPS } from "./bodrickHatPhraseCatalog";

const STORAGE_KEY = "bodrick_hat_said_phrases";
const GROUP_NAMES = Object.keys(BODRICK_PHRASE_GROUPS);

const pickRandom = (items) => items[Math.floor(Math.random() * items.length)];

const normalizeGroupHistory = (value, groupName) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const validIds = new Set(
    BODRICK_PHRASE_GROUPS[groupName].map((phrase) => phrase.id)
  );
  return [...new Set(value.filter((id) => validIds.has(id)))];
};

const readHistory = () => {
  try {
    const parsed = JSON.parse(getStoredValue(STORAGE_KEY) ?? "{}");
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        GROUP_NAMES.map((name) => [
          name,
          name === "general" ? normalizeGroupHistory(parsed, name) : [],
        ])
      );
    }
    return Object.fromEntries(
      GROUP_NAMES.map((name) => {
        const current = Array.isArray(parsed?.[name]) ? parsed[name] : [];
        const legacyQuiet =
          (name === "muted" || name === "low") && Array.isArray(parsed?.quiet)
            ? parsed.quiet
            : [];
        return [name, normalizeGroupHistory([...current, ...legacyQuiet], name)];
      })
    );
  } catch {
    return Object.fromEntries(GROUP_NAMES.map((name) => [name, []]));
  }
};

const selectGroup = ({ isPlaying, isLocalPaused, isMuted, volume }) => {
  if (!isPlaying || isLocalPaused) {
    return "general";
  }
  if (isMuted) {
    return "muted";
  }
  if (volume >= 0.85) {
    return "loud";
  }
  if (volume < 0.1) {
    return "low";
  }
  return "general";
};

export const pickNextBodrickPhrase = (playbackState = {}) => {
  const groupName = selectGroup(playbackState);
  const phrases = BODRICK_PHRASE_GROUPS[groupName];
  const history = readHistory();
  const seenIds = history[groupName];
  const seen = new Set(seenIds);
  let available = phrases.filter((phrase) => !seen.has(phrase.id));
  let nextSeenIds = seenIds;

  if (available.length === 0) {
    const previousId = seenIds.at(-1);
    available = phrases.filter((phrase) => phrase.id !== previousId);
    nextSeenIds = [];
  }

  const phrase = pickRandom(available);
  const variant = pickRandom(phrase.variants);
  history[groupName] = [...nextSeenIds, phrase.id];

  try {
    setStoredValue(STORAGE_KEY, JSON.stringify(history));
  } catch {}

  return { text: phrase.text, variant };
};
