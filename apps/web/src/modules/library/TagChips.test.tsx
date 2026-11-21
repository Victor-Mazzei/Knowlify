import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TagWithCount } from "../../types";
import { CardTagDots, TableTags, tagsForBook } from "./TagChips";

const tag = (id: string, name: string): TagWithCount => ({
  id,
  name,
  color: "blue",
  createdAt: 0,
  count: 1,
});

const tags = [tag("1", "One"), tag("2", "Two"), tag("3", "Three")];

describe("tag chips", () => {
  it("shows at most two dots plus the hidden count on a card", () => {
    render(<CardTagDots tags={tags} />);
    const wrapper = screen.getByLabelText("Tags: One, Two, Three");
    expect(wrapper.querySelectorAll(".tag-dot")).toHaveLength(2);
    expect(wrapper).toHaveTextContent("+1");
  });

  it("shows at most two text chips plus the hidden count in the table", () => {
    render(<TableTags tags={tags} />);
    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
    expect(screen.queryByText("Three")).not.toBeInTheDocument();
    expect(screen.getByLabelText("1 more tags")).toHaveTextContent("+1");
  });

  it("resolves ids in their stored order and drops unknown ids", () => {
    expect(tagsForBook(["3", "missing", "1"], tags).map((entry) => entry.name)).toEqual(["Three", "One"]);
    expect(tagsForBook(undefined, tags)).toEqual([]);
  });
});
