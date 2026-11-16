"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

interface ListEditorProps {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  maxItems?: number;
}

interface SortableItemProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
}

function SortableItem({ id, value, onChange, onRemove }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    height: "28px",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1.5 group bg-surface border border-border rounded-sm px-2 hover:border-border-strong transition-colors duration-fast"
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        className="p-0.5 text-fg-faint hover:text-fg-muted cursor-grab active:cursor-grabbing transition-colors duration-fast flex-shrink-0"
        aria-label="Drag to reorder"
      >
        <GripVertical size={12} />
      </button>

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-transparent border-none text-fg text-sm placeholder:text-fg-faint focus:outline-none leading-none"
        placeholder="Add item…"
      />

      <button
        type="button"
        onClick={onRemove}
        className="p-0.5 text-fg-faint hover:text-fg opacity-0 group-hover:opacity-100 transition-all duration-fast flex-shrink-0"
        aria-label="Remove item"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export function ListEditor({
  items,
  onChange,
  placeholder = "Add item…",
  maxItems = 10,
}: ListEditorProps) {
  const [ids] = useState(() => items.map((_, i) => `item-${i}-${Math.random()}`));
  const [itemIds, setItemIds] = useState<string[]>(ids);

  // Items can grow from outside (suggestion chips append to the list). Keep
  // one stable id per item so drag-and-drop and removal stay aligned.
  useEffect(() => {
    if (items.length > itemIds.length) {
      setItemIds((prev) => [
        ...prev,
        ...items.slice(prev.length).map((_, i) => `ext-${Date.now()}-${i}-${Math.random()}`),
      ]);
    }
  }, [items, itemIds.length]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = itemIds.indexOf(String(active.id));
      const newIndex = itemIds.indexOf(String(over.id));
      const newIds = [...itemIds];
      const [removed] = newIds.splice(oldIndex, 1);
      if (removed !== undefined) {
        newIds.splice(newIndex, 0, removed);
      }
      setItemIds(newIds);

      const newItems = [...items];
      const [removedItem] = newItems.splice(oldIndex, 1);
      if (removedItem !== undefined) {
        newItems.splice(newIndex, 0, removedItem);
      }
      onChange(newItems);
    }
  }

  function addItem() {
    if (items.length >= maxItems) return;
    const newId = `item-${Date.now()}-${Math.random()}`;
    setItemIds((prev) => [...prev, newId]);
    onChange([...items, ""]);
  }

  function updateItem(index: number, value: string) {
    const newItems = [...items];
    newItems[index] = value;
    onChange(newItems);
  }

  function removeItem(index: number) {
    const newIds = [...itemIds];
    newIds.splice(index, 1);
    setItemIds(newIds);
    const newItems = [...items];
    newItems.splice(index, 1);
    onChange(newItems);
  }

  return (
    <div className="flex flex-col gap-1">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.map((item, i) => {
            const id = itemIds[i] ?? `fallback-${i}`;
            return (
              <SortableItem
                key={id}
                id={id}
                value={item}
                onChange={(val) => updateItem(i, val)}
                onRemove={() => removeItem(i)}
              />
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
