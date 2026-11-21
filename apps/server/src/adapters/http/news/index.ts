import type { FastifyInstance } from 'fastify';
import type { News } from '../../../use-cases/News.js';
export async function newsRoutes(app: FastifyInstance, { news }: { news: News }) {
  app.get('/feeds', async () => news.listFeeds());
  app.post<{ Body: unknown }>('/feeds', async (req, reply) => reply.code(201).send(await news.addFeed(req.body)));
  app.patch<{ Params: { id: string }; Body: unknown }>('/feeds/:id', async req => news.updateFeed(req.params.id, req.body));
  app.delete<{ Params: { id: string } }>('/feeds/:id', async (req, reply) => { news.deleteFeed(req.params.id); return reply.code(204).send(); });
  app.get<{ Querystring: { feedId?: string; limit?: string } }>('/articles', async req => news.articles(req.query.feedId, req.query.limit));
  app.get<{ Querystring: { q?: string; limit?: string } }>('/search', async req => news.search(req.query.q, req.query.limit));
  app.get('/bookmarks', async () => news.listBookmarks());
  app.post<{ Body: unknown }>('/bookmarks', async (req, reply) => reply.code(201).send(news.addBookmark(req.body)));
  app.delete<{ Params: { id: string } }>('/bookmarks/:id', async (req, reply) => { news.deleteBookmark(req.params.id); return reply.code(204).send(); });
}
