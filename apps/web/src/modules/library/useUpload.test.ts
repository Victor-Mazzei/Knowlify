import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUpload } from "./useUpload";

describe("useUpload", () => {
  it("rejects unsupported files without calling the API", async () => {
    const api = vi.fn(async () => new Response("{}"));
    const onError = vi.fn();
    const { result } = renderHook(() => useUpload(api, vi.fn(async () => undefined), onError));
    await act(async () => {
      await result.current.upload(new File(["x"], "notes.txt"));
    });
    expect(onError).toHaveBeenCalledWith("Only PDF and EPUB files are supported.");
    expect(api).not.toHaveBeenCalled();
  });

  it("uploads a book and reports completion", async () => {
    const api = vi.fn(async () => new Response("{}"));
    const onUploaded = vi.fn(async () => undefined);
    const { result } = renderHook(() => useUpload(api, onUploaded, vi.fn()));
    await act(async () => {
      await result.current.upload(new File(["x"], "book.epub"));
    });
    expect(api).toHaveBeenCalledWith("/api/books", expect.objectContaining({ method: "POST" }));
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ name: "book.epub" }));
    expect(result.current.uploading).toBe(false);
  });

  it("keeps the 201 flow when the server does not deduplicate", async () => {
    const api = vi.fn(
      async () => new Response(JSON.stringify({ id: "new", title: "New book" }), { status: 201 }),
    );
    const onUploaded = vi.fn(async () => undefined);
    const { result } = renderHook(() => useUpload(api, onUploaded, vi.fn()));
    await act(async () => {
      await result.current.upload(new File(["x"], "book.epub"));
    });
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(result.current.duplicate).toBeNull();
  });

  it("reports a duplicate without adding the book again", async () => {
    const api = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "canon", title: "Dune", duplicateOf: "canon" }), { status: 200 }),
    );
    const onUploaded = vi.fn(async () => undefined);
    const { result } = renderHook(() => useUpload(api, onUploaded, vi.fn()));
    await act(async () => {
      await result.current.upload(new File(["x"], "dune.epub"));
    });
    expect(onUploaded).not.toHaveBeenCalled();
    expect(result.current.duplicate).toEqual({ id: "canon", title: "Dune" });
    expect(result.current.uploading).toBe(false);
  });

  it("dismisses the duplicate notice", async () => {
    const api = vi.fn(
      async () => new Response(JSON.stringify({ id: "canon", duplicateOf: "canon" }), { status: 200 }),
    );
    const { result } = renderHook(() => useUpload(api, vi.fn(async () => undefined), vi.fn()));
    await act(async () => {
      await result.current.upload(new File(["x"], "dune.epub"));
    });
    act(() => result.current.dismissDuplicate());
    expect(result.current.duplicate).toBeNull();
  });

  it("surfaces the server message when the upload fails", async () => {
    const api = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "File is too large." }), { status: 400 }),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useUpload(api, vi.fn(async () => undefined), onError));
    await act(async () => {
      await result.current.upload(new File(["x"], "book.epub"));
    });
    expect(onError).toHaveBeenCalledWith("File is too large.");
  });
});
