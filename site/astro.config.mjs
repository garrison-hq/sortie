// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightBlog from 'starlight-blog';

// Deployed as a GitHub Pages project site, hence the /sortie base path.
// When a custom domain arrives, change `site` and drop `base`.
export default defineConfig({
  site: 'https://garrison-hq.github.io',
  base: '/sortie',
  integrations: [
    starlight({
      title: 'sortie',
      description:
        'Local-first web agents: natural-language goal in, real browser actions, schema-validated JSON out.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/garrison-hq/sortie',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/garrison-hq/sortie/edit/main/site/',
      },
      plugins: [
        starlightBlog({
          authors: {
            jeroen: {
              name: 'Jeroen Nouws',
              title: 'Maintainer',
            },
          },
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [{ slug: 'getting-started' }],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/extraction' },
            { slug: 'guides/agents' },
            { slug: 'guides/search-fetch' },
            { slug: 'guides/queries-profiles' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/cli' },
            { slug: 'reference/sdk' },
            { slug: 'reference/server-api' },
            { slug: 'reference/mcp' },
            { slug: 'reference/architecture' },
          ],
        },
      ],
    }),
  ],
});
