import {
  AudioLines,
  Check,
  ChevronRight,
  CodeXml,
  Copy,
  Download,
  Edit3,
  Ear,
  ExternalLink,
  Focus,
  FileText,
  Paperclip,
  Hand,
  Headphones,
  House,
  Image,
  Keyboard,
  Languages,
  ListPlus,
  Mic,
  Pause,
  Play,
  Plus,
  Repeat,
  Send,
  ShieldCheck,
  Smile,
  SkipForward,
  Square,
  Trash2,
  User,
  Video,
  Volume2,
  VolumeX,
  X,
  Youtube,
} from "lucide-react";

/** One icon vocabulary for player, Studio and isolated meeting UI; no legacy icon fonts. */
const icons = {
  "audio-lines": AudioLines,
  ear: Ear,
  focus: Focus,
  document: FileText,
  attachment: Paperclip,
  hand: Hand,
  mic: Mic,
  profile: User,
  room: House,
  moderator: ShieldCheck,
  shortcuts: Keyboard,
  language: Languages,
  code: CodeXml,
  "external-link": ExternalLink,
  headphones: Headphones,
  image: Image,
  video: Video,
  check: Check,
  "arrow-right": ChevronRight,
  close: X,
  copy: Copy,
  download: Download,
  edit: Edit3,
  next: SkipForward,
  pause: Pause,
  play: Play,
  stop: Square,
  plus: Plus,
  "queue-add": ListPlus,
  repeat: Repeat,
  send: Send,
  smile: Smile,
  trash: Trash2,
  volume: Volume2,
  "volume-mute": VolumeX,
  youtube: Youtube,
};

/** Render decorative Lucide icons with a useful intrinsic size even outside Tailwind globals. */
export default function Icon({
  name,
  size = 16,
  className = "h-4 w-4",
  strokeWidth = 2.4,
  ...props
}) {
  const Component = icons[name];
  if (!Component) {
    return null;
  }
  return (
    <Component
      aria-hidden="true"
      className={className}
      strokeWidth={strokeWidth}
      size={size}
      {...props}
    />
  );
}
