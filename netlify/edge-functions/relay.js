import { relay } from '../../lib/relay.js';
export default (request) => relay(request, Netlify.env.get('ACCESS_KEY'));
export const config = { path: '/api/relay' };
