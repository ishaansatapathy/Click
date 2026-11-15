import { guest } from '../../server/auth.js';

export const GET = (request: Request): Response | Promise<Response> => guest(request);
