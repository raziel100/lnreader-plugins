import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters } from '@libs/filterInputs';
import { load as loadCheerio } from 'cheerio';
import { NovelStatus } from '@libs/novelStatus';

class NovelArrow implements Plugin.PluginBase {
  id = 'novelarrow';
  name = 'Novel Arrow';
  icon = 'src/en/novelarrow/icon.png';
  site = 'https://novelping.com/';
  version = '2.0.0';
  filters: Filters | undefined = {
    sort: {
      type: 'Picker',
      label: 'Sort',
      value: 'updates',
      options: [
        { label: 'Latest Updates', value: 'updates' },
        { label: 'Recently Added', value: 'NEW' },
        { label: 'Top (All Time)', value: 'ALL_TIME' },
        { label: 'Popular This Week', value: 'POPULAR' },
        { label: 'Top Rated', value: 'RATING' },
        { label: 'Most Chapters', value: 'CHAPTERS' },
      ],
    },
    status: {
      type: 'Picker',
      label: 'Status',
      value: 'all',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
      ],
    },
  };

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const sort = filters?.sort?.value || 'updates';
    const status = filters?.status?.value || 'all';

    let url: string;

    if (showLatestNovels) {
      // Latest tab
      url = `${this.site}sort/updates?page=${pageNo}`;
    } else {
      // Popular tab by default
      url = `${this.site}sort/popular?page=${pageNo}`;
    }

    // Sort filters (NEW, ALL_TIME, POPULAR, RATING, CHAPTERS) apply on updates
    if (!showLatestNovels && sort !== 'updates') {
      url = `${this.site}sort/updates?sort=${sort}&page=${pageNo}`;
    }

    // Status filters (ongoing/completed)
    if (status !== 'all') {
      url = `${this.site}sort/updates/${status}?page=${pageNo}`;
    }

    const html = await fetchApi(url).then(r => r.text());
    const $ = loadCheerio(html);

    const novels: Plugin.NovelItem[] = [];

    $('.novel-title a').each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      const cover = $(el)
      .closest('.col-xs-7')
      .prev('.col-xs-3')
      .find('img')
      .attr('src');

      if (title && href) {
        const slug = href.replace(this.site + 'book/', '');
        novels.push({
          name: title,
          cover,
          path: `novel/${slug}`,
        });
      }
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath.replace('novel/', '');
    const url = `${this.site}book/${slug}`;

    const html = await fetchApi(url).then(r => r.text());
    const $ = loadCheerio(html);

    const name =
    $('h1').first().text().trim() ||
    $('.novel-title').first().text().trim();

    const cover =
    $('.novel-cover img').attr('src') ||
    $('img').first().attr('src');

    const author =
    $('.author').first().text().trim() ||
    $('meta[name="author"]').attr('content') ||
    '';

    const summary =
    $('.site-reading-copy p')
    .map((i, el) => $(el).text().trim())
    .get()
    .join('\n\n') ||
    $('.site-reading-copy').text().trim();

    const genres = $('.genres a')
    .map((i, el) => $(el).text().trim())
    .get()
    .join(', ');

    const statusText = $('.status')
    .text()
    .trim()
    .toLowerCase();

    let status = NovelStatus.Unknown;
    if (statusText.includes('ongoing')) status = NovelStatus.Ongoing;
    else if (statusText.includes('completed')) status = NovelStatus.Completed;

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name,
      cover,
      author,
      summary,
      genres,
      status,
      chapters: [],
    };

    const apiUrl = `${this.site}api-web/novels/${slug}/chapters?sort=asc`;

    try {
      const json = await fetchApi(apiUrl, {
        headers: { Accept: 'application/json' },
      }).then(r => r.json());

      if (json?.items) {
        novel.chapters = json.items.map(
          (item: { chapter_name: string; chapter_id: string }) => ({
            name: item.chapter_name,
            path: `chapter/${slug}/${item.chapter_id}`,
            releaseTime: null,
          }),
        );
      }
    } catch {
      // fallback: try to grab chapter links from HTML if needed
      $('a[href*="/chapter/"]').each((i, el) => {
        const href = $(el).attr('href');
        const name = $(el).text().trim();
        if (!href || !name) return;

        const clean = href
        .replace(this.site, '')
        .replace('/book/', 'chapter/');

        novel.chapters.push({
          name,
          path: clean,
          releaseTime: null,
        });
      });
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const clean = chapterPath.replace('chapter/', '');
    const [slug, chapterId] = clean.split('/');

    const apiUrl = `${this.site}api-web/novels/${slug}/chapters/${chapterId}`;

    try {
      const json = await fetchApi(apiUrl, {
        headers: {
          Accept: 'application/json',
          'x-track-reading-progress': 'false',
        },
      }).then(r => r.json());

      if (json?.item?.chapterInfo?.chapter_content) {
        return json.item.chapterInfo.chapter_content;
      }
    } catch {
      // fall through to HTML
    }

    const url = `${this.site}chapter/${slug}/${chapterId}`;
    const html = await fetchApi(url).then(r => r.text());
    const $ = loadCheerio(html);

    let content =
    $('.site-reading-copy, .chapter-content, .reading-content').html() ||
    '';

    if (!content) return 'Content not found or premium.';

    content = content
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/g, '')
    .replace(/<div[^>]*class="ads?[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<div[^>]*class="unlock-buttons[^"]*"[\s\S]*?<\/div>/gi, '');

    return content;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}search?keyword=${encodeURIComponent(
      searchTerm,
    )}&page=${pageNo}`;

    const html = await fetchApi(url).then(r => r.text());
    const $ = loadCheerio(html);

    const novels: Plugin.NovelItem[] = [];

    $('.novel-title a').each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href');
      const cover = $(el)
      .closest('.col-xs-7')
      .prev('.col-xs-3')
      .find('img')
      .attr('src');

      if (title && href) {
        const slug = href.replace(this.site + 'book/', '');
        novels.push({
          name: title,
          cover,
          path: `novel/${slug}`,
        });
      }
    });

    return novels;
  }

  resolveUrl = (path: string, isNovel?: boolean) =>
  this.site + (isNovel ? 'book/' : '') + path;
}

export default new NovelArrow();
