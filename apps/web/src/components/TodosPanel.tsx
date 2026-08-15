import { ListTodo } from "lucide-react";

import type { WorkLogTodoItem } from "../session-logic";
import { ScrollArea } from "./ui/scroll-area";
import { TodoChecklist } from "./TodoChecklist";

export function TodosPanel({ items }: { items: ReadonlyArray<WorkLogTodoItem> | null }) {
  if (!items || items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <ListTodo aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">{items ? "No todos" : "No todos yet"}</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Todo updates from this thread will appear here.
        </p>
      </div>
    );
  }

  const completedCount = items.filter((item) => item.status === "completed").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-4 py-3">
        <p className="text-xs text-muted-foreground tabular-nums">
          {completedCount} of {items.length} completed
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <TodoChecklist items={items} className="p-4" />
      </ScrollArea>
    </div>
  );
}
