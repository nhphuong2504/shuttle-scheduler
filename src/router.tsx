import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    /**
     * A route's `validateSearch` is the whole truth about its search params.
     *
     * Off by default, and the default is the wrong answer here: an unrecognised param is
     * *kept* and merged around the validator, so `/explore?status=draft` reached the page
     * with `status: "draft"` and was forwarded to the database, and `?step=nonsense` on a
     * wizard route rendered a step that does not exist. Every `validateSearch` in this app
     * exists to narrow an address to the words the page has - that is what makes a URL
     * shareable rather than merely parsable - so an address the validator did not return is
     * dropped rather than carried past it.
     */
    search: { strict: true },
  });

  return router;
};
