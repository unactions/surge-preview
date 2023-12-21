/* eslint-disable indent */
/* eslint-disable unicorn/consistent-destructuring */
/* eslint-disable unicorn/no-null */

import fs from 'node:fs';

import * as core from '@actions/core';
import { exec } from '@actions/exec';
import * as github from '@actions/github';
import { renderBase64 } from 'hqr';

import { comment } from '../commentToPullRequest';
import { execSurgeCommand, formatImage, getCommentFooter } from '../helpers';

let failOnErrorGlobal = false;
let fail: (err: Error, duration?: number) => void;

export const deployPullRequest = async ({
  surgeToken,
  octokit,
  dist,
  teardown,
  failOnError,
}: any) => {
  failOnErrorGlobal = failOnError;
  core.debug(`failOnErrorGlobal: ${typeof failOnErrorGlobal} + ${failOnErrorGlobal.toString()}`);
  let prNumber: number | undefined;

  core.debug('github.context');
  core.debug(JSON.stringify(github.context, null, 2));
  const { job, payload } = github.context;
  core.debug(`payload.after: ${payload.after}`);
  core.debug(`payload.pull_request: ${payload.pull_request}`);
  const gitCommitSha =
    payload.after || payload?.pull_request?.head?.sha || payload?.workflow_run?.head_sha;
  core.debug(JSON.stringify(github.context.repo, null, 2));

  core.debug(`payload.pull_request?.head: ${payload.pull_request?.head}`);
  const fromForkedRepo = payload.pull_request?.head.repo.fork;

  if (payload.number && payload.pull_request) {
    prNumber = payload.number;
  } else {
    const result = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      commit_sha: gitCommitSha,
    });
    const pr = result.data.length > 0 && result.data[0];
    core.debug('listPullRequestsAssociatedWithCommit');
    core.debug(JSON.stringify(pr, null, 2));
    prNumber = pr ? pr.number : undefined;
  }

  if (!prNumber) {
    core.info('😢 No related PR found, skip it.');
    return;
  }

  core.info(`Find PR number: ${prNumber}`);

  const commentIfNotForkedRepo = (message: string) => {
    // if it is forked repo, don't comment
    if (fromForkedRepo) {
      core.info('PR created from a forked repository, so skip PR comment');
      return;
    }
    comment({
      repo: github.context.repo,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      number: prNumber!,
      message,
      octokit,
      header: job,
    });
  };

  fail = (err: Error, duration?: number) => {
    core.info('error message:');
    core.info(JSON.stringify(err, null, 2));
    commentIfNotForkedRepo(`
${formatImage({
  buildingLogUrl,
  gitCommitSha,
  buildTime: `${duration || 0}s`,
  url: `https://${url}`,
  status: '❌ Failed',
})}

${getCommentFooter()}
    `);
    if (failOnError) {
      core.setFailed(err.message);
    }
  };

  // @ts-ignore
  const repoOwner = github.context.repo.owner.replaceAll('.', '-');
  // @ts-ignore
  const repoName = github.context.repo.repo.replaceAll('.', '-');
  const url = `${repoOwner}-${repoName}-${job}-pr-${prNumber}.surge.sh`;

  core.setOutput('preview_url', url);

  let data;

  try {
    const result = await octokit.rest.checks.listForRef({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      ref: gitCommitSha,
    });
    data = result.data;
  } catch (error: any) {
    fail(error);
    return;
  }

  core.debug(JSON.stringify(data?.check_runs, null, 2));

  // 尝试获取 check_run_id，逻辑不是很严谨
  let checkRunId;
  if (data?.check_runs?.length >= 0) {
    const checkRun = data?.check_runs?.find((item: any) => item.name === job);
    checkRunId = checkRun?.id;
  }

  const buildingLogUrl = checkRunId
    ? `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/runs/${checkRunId}`
    : `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`;

  core.debug(`teardown enabled?: ${teardown}`);
  core.debug(`event action?: ${payload.action}`);

  if (teardown && payload.action === 'closed') {
    try {
      core.info(`Teardown: ${url}`);
      core.setSecret(surgeToken);
      await execSurgeCommand({
        command: ['surge', 'teardown', url, '--token', surgeToken],
      });

      return commentIfNotForkedRepo(`
${formatImage({
  buildingLogUrl,
  gitCommitSha,
  url: `https://${url}`,
  status: ':recycle: Destroyed',
})}

${getCommentFooter()}
      `);
    } catch (error: any) {
      return fail?.(error);
    }
  }

  commentIfNotForkedRepo(`
${formatImage({
  buildingLogUrl,
  gitCommitSha,
  url: `https://${url}`,
  status: '⌛ Deploying',
})}

${getCommentFooter()}
  `);

  const startTime = Date.now();
  try {
    if (core.getInput('build')) {
      const buildCommands = core.getInput('build').split('\n');
      for (const command of buildCommands) {
        core.info(`RUN: ${command}`);
        await exec(command);
      }
    } else {
      await exec('npm install');
      await exec('npm run build');
    }

    const qrUrl = await renderBase64(`https://${url}`, { width: 200, height: 200 });

    fs.writeFileSync(`${dist}/qr.png`, qrUrl.replace('data:image/png;base64,', ''), 'base64');

    await exec('cp', [`${dist}/index.html`, `${dist}/200.html`]);

    const duration = (Date.now() - startTime) / 1000;
    core.info(`Build time: ${duration} seconds`);
    core.info(`Deploy to ${url}`);
    core.setSecret(surgeToken);

    await execSurgeCommand({
      command: ['surge', `./${dist}`, url, '--token', surgeToken],
    });

    commentIfNotForkedRepo(`
${formatImage({
  buildingLogUrl,
  qrUrl: `https://${url}/qr.png`,
  gitCommitSha,
  url: `https://${url}`,
  status: '✅ Ready',
  buildTime: `${duration}s`,
})}

${getCommentFooter()}
    `);
  } catch (error: any) {
    const duration = (Date.now() - startTime) / 1000;

    fail?.(error, duration);
  }
};
