import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TodosPanel } from "./TodosPanel";

describe("TodosPanel", () => {
  it("shows a stable empty state before the first checklist update", () => {
    const html = renderToStaticMarkup(<TodosPanel items={null} />);

    expect(html).toContain("No todos yet");
    expect(html).toContain("Todo updates from this thread will appear here.");
  });

  it("shows an explicit empty state after a checklist is cleared", () => {
    const html = renderToStaticMarkup(<TodosPanel items={[]} />);

    expect(html).toContain("No todos");
    expect(html).not.toContain("No todos yet");
  });

  it("retains completed items and exposes every status accessibly", () => {
    const html = renderToStaticMarkup(
      <TodosPanel
        items={[
          { content: "Inspect", status: "completed" },
          { content: "Implement", status: "inProgress" },
          { content: "Verify", status: "pending" },
          { content: "Discarded", status: "cancelled" },
        ]}
      />,
    );

    expect(html).toContain("1 of 4 completed");
    expect(html).toContain("Completed: ");
    expect(html).toContain("In progress: ");
    expect(html).toContain("Pending: ");
    expect(html).toContain("Cancelled: ");
    expect(html).toContain("Discarded");
  });
});
