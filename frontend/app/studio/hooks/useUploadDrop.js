import { useState } from "react";

/** Own drag/drop affordance state while delegating accepted files to uploads. */
export default function useUploadDrop({ uploadFiles }) {
  const [isDragging, setIsDragging] = useState(false);

  /** Mark a valid drag surface after preventing browser navigation. */
  const onDragOver = (event) => {
    event.preventDefault();
    setIsDragging(true);
  };

  /** Clear drag affordance when the pointer leaves the drop surface. */
  const onDragLeave = () => {
    setIsDragging(false);
  };

  /** Consume dropped files without allowing the browser to open them. */
  const onDrop = async (event) => {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.length) {
      return;
    }
    await uploadFiles(files);
  };

  return {
    isDragging,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
