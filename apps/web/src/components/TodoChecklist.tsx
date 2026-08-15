import type { WorkLogTodoItem } from "../session-logic";
import { cn } from "../lib/utils";

export function TodoChecklist({
  items,
  className,
}: {
  items: ReadonlyArray<WorkLogTodoItem>;
  className?: string;
}) {
  return (
    <ul className={cn("space-y-px", className)} aria-label="Todo checklist">
      {items.map((todo, index) => (
        <li
          key={`${todo.content}:${index}`}
          className="flex items-baseline gap-2 text-[12px] leading-5"
        >
          <span
            className={cn(
              "w-3 shrink-0 text-center font-mono text-[10px]",
              todo.status === "completed"
                ? "text-success"
                : todo.status === "inProgress"
                  ? "text-primary"
                  : todo.status === "cancelled"
                    ? "text-muted-foreground/35"
                    : "text-muted-foreground/40",
            )}
            aria-hidden
          >
            {todo.status === "completed"
              ? "✓"
              : todo.status === "inProgress"
                ? "●"
                : todo.status === "cancelled"
                  ? "×"
                  : "○"}
          </span>
          <span
            className={cn(
              "min-w-0",
              todo.status === "completed" || todo.status === "cancelled"
                ? "text-muted-foreground/55"
                : todo.status === "inProgress"
                  ? "text-foreground/90"
                  : "text-muted-foreground/70",
              todo.status === "cancelled" && "line-through",
            )}
          >
            <span className="sr-only">
              {todo.status === "completed"
                ? "Completed: "
                : todo.status === "inProgress"
                  ? "In progress: "
                  : todo.status === "cancelled"
                    ? "Cancelled: "
                    : "Pending: "}
            </span>
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}
