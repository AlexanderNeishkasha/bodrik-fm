import Image from "next/image";
import { assetUrl } from "../lib/asset";

export default function AssetImage({ src, alt = "", width, height, ...props }) {
  const resolvedSrc = typeof src === "string" ? assetUrl(src) : src;

  return (
    <Image
      src={resolvedSrc}
      alt={alt}
      width={width}
      height={height}
      unoptimized
      {...props}
    />
  );
}
