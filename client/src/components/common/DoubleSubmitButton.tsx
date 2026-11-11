import React, { useState } from "react";

interface DoubleSubmitButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pendingText?: string;
  onAsyncClick?: () => Promise<void> | void;
}

export const DoubleSubmitButton: React.FC<DoubleSubmitButtonProps> = ({
  children,
  pendingText = "Elaborazione...",
  onAsyncClick,
  disabled,
  onClick,
  ...rest
}) => {
  const [isPending, setIsPending] = useState<boolean>(false);

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isPending) return;
    if (onClick) onClick(e);
    if (!onAsyncClick) return;

    setIsPending(true);
    try {
      await onAsyncClick();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <button
      {...rest}
      disabled={disabled || isPending}
      onClick={handleClick}
      data-pending={isPending ? "true" : undefined}
    >
      {isPending ? pendingText : children}
    </button>
  );
};
