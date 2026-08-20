// 12a expansion index. Mounts every new endpoint group onto one Hono sub-app
// that routes.ts mounts at the root of /api (so it shares attachUser +
// globalRateLimit with the existing surface). Path prefixes are chosen to not
// collide with existing routes: /players/*, /seasons/*, /economy/*,
// /legions/*, /vote/*, /shop/*, /dungeons/* are all new namespaces (the
// existing player/legion/store routes are singular).
import { Hono } from 'hono';
import { playersApi, dungeonsApi } from './players.js';
import { seasonsApi } from './seasons.js';
import { economyApi } from './economy.js';
import { legionsApi } from './legions.js';
import { webshopApi } from './webshop.js';
import { communityApi } from './community.js';
import { adminViewsApi } from './adminViews.js';
import { publicApi } from './publicProfiles.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const expansionApi = new Hono<ApiEnv>();

expansionApi.route('/players', playersApi);
expansionApi.route('/seasons', seasonsApi);
expansionApi.route('/economy', economyApi);
expansionApi.route('/legions', legionsApi);
expansionApi.route('/', webshopApi);
expansionApi.route('/', communityApi);
expansionApi.route('/', adminViewsApi);
expansionApi.route('/dungeons', dungeonsApi);
// V6 /v2 wave starts here: public, unauthenticated projections with their own
// privacy-scoped schemas (04-03 public profiles is the first resident).
expansionApi.route('/v2/public', publicApi);
