import type { FastifyInstance } from "fastify";
import type { Notes } from "../../use-cases/Notes.js";
import type { NoteInput } from "../../domain/reading/Note.js";
import { noteDto, noteGroupDto } from "./dto.js";

interface GroupsQuerystring {
  q?: string;
  limit?: string;
  perGroup?: string;
  cursor?: string;
}

export async function noteRoutes(app: FastifyInstance, opts: { notes: Notes }) {
  const { notes } = opts;
  app.get<{ Querystring: { q?: string; limit?: string } }>("/notes", async req => notes.search(req.query.q, req.query.limit).map(noteDto));
  app.get<{ Querystring: GroupsQuerystring }>("/notes/groups", async (req, reply) => {
    reply.header("Vary", "Authorization");
    const page = notes.groups(req.query);
    return {
      items: page.groups.map(noteGroupDto),
      nextCursor: page.nextCursor,
      totalBooks: page.totalBooks,
      totalNotes: page.totalNotes,
    };
  });
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/books/:id/notes", async req =>
    notes.list(req.params.id, req.query.q).map(noteDto));
  app.post<{ Params: { id: string }; Body: NoteInput }>("/books/:id/notes", async (req, reply) => reply.code(201).send(noteDto(notes.add(req.params.id, req.body))));
  app.patch<{ Params: { id: string }; Body: NoteInput }>("/notes/:id", async req => noteDto(notes.update(req.params.id, req.body)));
  app.delete<{ Params: { id: string } }>("/notes/:id", async (req, reply) => { notes.delete(req.params.id); return reply.code(204).send(); });
}
