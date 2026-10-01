import { onRequestPost as __api_admin_ts_onRequestPost } from "/Users/thegt/aura-music/functions/api/admin.ts"

export const routes = [
    {
      routePath: "/api/admin",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_admin_ts_onRequestPost],
    },
  ]