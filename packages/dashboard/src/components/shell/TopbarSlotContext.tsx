"use client";

import * as React from "react";

interface TopbarSlotContextValue {
  rightSlot: React.ReactNode;
  setRightSlot: (node: React.ReactNode) => void;
}

export const TopbarSlotContext = React.createContext<TopbarSlotContextValue>({
  rightSlot: null,
  setRightSlot: () => {},
});

export function TopbarSlotProvider({ children }: { children: React.ReactNode }) {
  const [rightSlot, setRightSlot] = React.useState<React.ReactNode>(null);
  return (
    <TopbarSlotContext.Provider value={{ rightSlot, setRightSlot }}>
      {children}
    </TopbarSlotContext.Provider>
  );
}

/** Call this from a screen component to register an action in the topbar's right slot. */
export function useTopbarRightSlot(node: React.ReactNode) {
  const { setRightSlot } = React.useContext(TopbarSlotContext);
  React.useEffect(() => {
    setRightSlot(node);
    return () => setRightSlot(null);
  }, [node, setRightSlot]);
}
