import { logout } from '../../server/auth.js';

export const GET = (request: Request): Response | Promise<Response> => logout(request);
