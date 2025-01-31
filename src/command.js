import Command, { flags } from '@percy/cli-command';
import request from '@percy/client/dist/request';
import { sha256hash } from '@percy/client/dist/utils';
import Percy from '@percy/core';
import PercyConfig from '@percy/config';
import { merge } from '@percy/config/dist/utils';
import { buildArgsParam } from '@storybook/router/utils';
import qs from 'qs';

import pkg from '../package.json';

// used to deserialize regular expression strings
const RE_REGEXP = /^\/(.+)\/(\w+)?$/;

export default class StorybookCommand extends Command {
  static flags = {
    ...flags.logging,
    ...flags.discovery,
    ...flags.config,

    include: flags.string({
      char: 'i',
      description: 'pattern matching story names to include in snapshots',
      percyrc: 'storybook.include',
      multiple: true
    }),
    exclude: flags.string({
      char: 'e',
      description: 'pattern matching story names to exclude from snapshots',
      percyrc: 'storybook.exclude',
      multiple: true
    }),
    'dry-run': flags.boolean({
      char: 'd',
      description: 'logs snapshots without creating a build'
    })
  };

  async run() {
    if (!this.isPercyEnabled()) {
      return this.log.info('Percy is disabled. Skipping snapshots');
    }

    this.percy = new Percy({
      ...this.percyrc(),
      clientInfo: `${pkg.name}/${pkg.version}`,
      server: false
    });

    let url = await this.storybook();
    let pages = await this.getStoryPages(url);
    let l = pages.length;

    if (!l) return this.error('No snapshots found');

    let dry = this.flags['dry-run'];
    if (dry) this.log.info(`Found ${l} snapshot${l === 1 ? '' : 's'}`);
    else await this.start();

    for (let page of pages) {
      if (dry) {
        this.log.info(`Snapshot found: ${page.name}`);
        this.log.debug(`-> url: ${page.url}`);
      } else {
        this.percy.snapshot(page);
      }
    }
  }

  // Called to start Percy
  async start() {
    // patch client to override root resources when JS is enabled
    this.percy.client.sendSnapshot = (buildId, options) => {
      if (options.enableJavaScript && this.preview) {
        Object.assign(options.resources.find(r => r.root), this.preview);
      }

      let { sendSnapshot } = this.percy.client.constructor.prototype;
      return sendSnapshot.call(this.percy.client, buildId, options);
    };

    await this.percy.start();
  }

  // Called on error, interupt, or after running
  async finally(error) {
    await this.percy?.stop(!!error);
    await this.percy?.browser.close();
  }

  // Resolves to an array of story pages to snapshot
  async getStoryPages(url) {
    let previewUrl = new URL('/iframe.html', url).href;
    let stories = await this.getStories(previewUrl);
    let validated = new Set();

    let storyPage = (id, name, options) => {
      // pluck out storybook specific options
      let { skip, args, queryParams, include, exclude, ...opts } = options;

      // add id, query params, and args to the url
      (queryParams ||= {}).id = id;
      if (args) queryParams.args = buildArgsParam({}, args);
      let url = `${previewUrl}?${qs.stringify(queryParams)}`;

      return { ...opts, name, url };
    };

    return stories.reduce((all, params) => {
      if (this.shouldSkipStory(params.name, params)) return all;

      // migrate, validate, scrub, and merge config
      let { id, ...config } = PercyConfig.migrate(params, '/storybook');
      let errors = PercyConfig.validate(config, '/storybook');
      let { name, additionalSnapshots = [], ...options } = (
        merge([this.percy.config.storybook, config]));

      if (errors) {
        if (!validated.size) {
          this.log.warn('Invalid parameters:');
        }

        for (let e of errors) {
          let message = `- percy.${e.path}: ${e.message}`;
          // ensure messages are only logged once for all stories
          if (!validated.has(message)) {
            this.log.warn(message);
            validated.add(message);
          }
        }
      }

      return all.concat(
        storyPage(id, name, options),
        additionalSnapshots.filter(s => !this.shouldSkipStory(name, s))
          .map(({ name: n, prefix, suffix, ...opts }) => {
            n ||= `${prefix || ''}${name}${suffix || ''}`;
            return storyPage(id, n, merge([options, opts]));
          })
      );
    }, []);
  }

  // Returns true or false if a story should be skipped or not
  shouldSkipStory(name, { skip, include, exclude }) {
    let conf = this.percy.config.storybook;

    let test = regexp => {
      /* istanbul ignore else: sanity check */
      if (typeof regexp === 'string') {
        let [, parsed, flags] = RE_REGEXP.exec(regexp) || [];
        regexp = new RegExp(parsed ?? regexp, flags);
      }

      return regexp?.test?.(name);
    };

    // percy include and exclude overrides storybook params
    if (conf?.include || conf?.exclude) {
      include = [].concat(conf?.include).filter(Boolean);
      exclude = [].concat(conf?.exclude).filter(Boolean);
    } else {
      include = [].concat(include).filter(Boolean);
      exclude = [].concat(exclude).filter(Boolean);
    }

    // if included, don't skip; if excluded always exclude
    skip = !!((include?.length ? !include.some(test) : skip) || exclude?.some(test));
    if (skip) this.log.debug(`Skipping story: ${name}`);
    return skip;
  }

  // Resolves to an array of Storybook stories
  async getStories(previewUrl) {
    let meta = { storybook: { url: previewUrl } };
    let page;

    try {
      this.log.debug(`Get stories: ${previewUrl}`, meta);

      // ensure the url is reachable while saving the response for when js is enabled
      let logTimeout = setTimeout(this.log.warn, 3000, 'Waiting on a response from Storybook...');
      let previewDOM = await request(previewUrl, { retries: 30, interval: 1000, retryNotFound: true });
      this.preview = { content: previewDOM, sha: sha256hash(previewDOM) };
      clearTimeout(logTimeout);

      // borrow a browser page to discover stories
      await this.percy.browser.launch();
      page = await this.percy.browser.page({ meta });
      await page.goto(previewUrl);

      /* istanbul ignore next: no instrumenting injected code */
      return await page.eval((util, previewUrl) => {
        let serializeRegExp = r => r && [].concat(r).map(r => r.toString());
        let storybook = window.__STORYBOOK_CLIENT_API__;

        if (!storybook) {
          throw new Error(
            'Storybook object not found on the window. ' +
            'Open Storybook and check the console for errors.'
          );
        }

        return storybook.raw().map(({ id, kind, name, parameters }) => ({
          name: `${kind}: ${name}`,
          ...parameters?.percy,
          include: serializeRegExp(parameters?.percy?.include),
          exclude: serializeRegExp(parameters?.percy?.exclude),
          id
        }));
      });
    } catch (error) {
      // remove stack traces from any eval error
      if (typeof error === 'string') {
        throw new Error(error.replace(/^Error:\s(.*?)\n\s{4}at\s.*$/s, '$1'));
      } else {
        throw error;
      }
    } finally {
      await page?.close();
    }
  }
}
