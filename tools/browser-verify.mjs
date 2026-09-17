/**
 * Browser verification: does it actually render?
 *
 * The legacy project's most expensive habit was asserting at the RPC layer and
 * calling the UI fixed. Tombstone deletion and message editing were marked
 * resolved across five review rounds and 98 unit tests and never once appeared
 * on screen, because every assertion watched the wire while the platform's
 * transcript projection quietly discarded the events those features produced.
 *
 * So this script asserts on the DOM the user would see, and it runs against a
 * real booted instance. It is deliberately NOT part of `pnpm run verify`: that
 * chain must stay runnable with no server and no browser. This is the other
 * half — the half that has to be run deliberately.
 *
 * Usage:
 *   node tools/browser-verify.mjs --url "<activation URL printed by dsh web>"
 *
 * Requires Playwright's Chromium in the environment running it:
 *   npx playwright install --with-deps chromium
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Packages whose browser halves must be present in the boot graph. */
const EXPECTED_ENTRIES = ['dsh-tavern', 'dsh-group-chat']

/**
 * Markers that only exist once a client half has actually run.
 *
 * Class names here are literal, not hashed: the build inlines each
 * `.module.css` as text and leaves the selectors untouched, so `dtv-icon` in
 * the stylesheet is `dtv-icon` in the DOM.
 */
const MARKERS = {
  'dsh-tavern panellist icon': '.dtv-icon',
  'dsh-tavern page (after click)': '.dtv-page',
}

function parseArgs(argv) {
  const options = { url: undefined, out: 'browser-verify.png', timeout: 30_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--url') options.url = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else if (arg === '--timeout') options.timeout = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.url === undefined) {
    throw new Error(
      'missing --url. Pass the activation URL that `dsh web` prints — the page needs it to '
      + 'establish the authority-bound cookie, and an unauthenticated request only returns '
      + '"dsh web authentication required".',
    )
  }
  return options
}

/** Import Playwright with an actionable message when it is absent. */
async function loadChromium() {
  try {
    const playwright = await import('playwright')
    return playwright.chromium
  } catch (error) {
    throw new Error(
      'Playwright is not installed in this environment. Run:\n'
      + '  npx playwright install --with-deps chromium\n'
      + `(original error: ${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/**
 * Dismiss a first-run overlay, if one is blocking the page.
 *
 * The platform shows an "Internal Testing Notice" behind a mask that intercepts
 * pointer events. Every click aimed at anything underneath then fails — and the
 * failure looks exactly like "our button does nothing", which is the single most
 * expensive shape of bug this script exists to catch. So the mask is cleared
 * deliberately, and what cleared it is reported.
 *
 * Each Playwright run gets a fresh browser context, so the notice reappears every
 * time regardless of what a human has already dismissed.
 */
async function dismissBlockingOverlay(page) {
  // Onboarding is a *sequence*, not one dialog: first a testing notice, then an
  // API-key prompt ("Configure later"). Clearing one only reveals the next, and
  // each one intercepts pointer events — so loop until the page is actually
  // free, rather than assuming a single dismissal is enough.
  const cleared = []
  for (let round = 0; round < 6; round += 1) {
    const mask = page.locator('[class*="_mask_"]').first()
    await mask.waitFor({ state: 'attached', timeout: round === 0 ? 8_000 : 1_500 }).catch(() => undefined)
    if ((await mask.count()) === 0) break

    const accepted = /^(continue|ok|got it|close|configure later|skip|not now|继续|知道了|我知道了|开始|关闭|稍后配置|稍后|跳过)$/i
    const buttons = page.locator('button')
    const count = await buttons.count()
    let acted = false

    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i)
      const label = (await button.innerText().catch(() => '')).trim()
      if (!accepted.test(label)) continue
      if (!(await button.isVisible().catch(() => false))) continue
      await button.click({ timeout: 5_000 })
      await mask.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
      cleared.push(`"${label}"`)
      acted = true
      break
    }

    if (!acted) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      // Nothing recognisable left: report what the overlay says, so the next
      // person knows which label to add instead of guessing.
      const text = (await page.locator('[role="presentation"]').first().innerText().catch(() => '')).trim()
      cleared.push(`Escape (unrecognised overlay: ${text.slice(0, 80).replace(/\s+/g, ' ') || 'no text'})`)
      break
    }
  }

  return cleared.length === 0 ? null : cleared.join(', ')
}

/** Click, clearing a blocking overlay once if the first attempt is intercepted. */
async function clickThroughOverlay(page, locator, notes) {
  try {
    await locator.click({ timeout: 5_000 })
    return
  } catch (error) {
    const cleared = await dismissBlockingOverlay(page)
    if (cleared === null) throw error
    notes.push(`  (click was intercepted; cleared the overlay via ${cleared} and retried)`)
    await locator.click({ timeout: 5_000 })
  }
}

/**
 * Drive the room manager and see a create round-trip.
 *
 * Deliberately goes through the UI rather than calling the endpoint directly:
 * the UI path is what a user takes, and it exercises the client's connection
 * service, the descriptor table, the gateway, the host's validator and the
 * durable table in one go.
 */
async function verifyRoomManager(page, notes, failures, out) {
  const roomName = `verify-${Date.now().toString(36)}`

  try {
    // Open Settings from the sidebar foot.
    const settingsTrigger = page.getByRole('button', { name: /settings|设置/i }).first()
    await clickThroughOverlay(page, settingsTrigger, notes)
    await page.waitForTimeout(500)

    // If the panel renders one section at a time, reveal ours. If it renders all
    // of them, the section is already there and the click is skipped.
    if ((await page.locator('.dgc-section').count()) === 0) {
      const navEntry = page.getByText('群聊', { exact: true }).first()
      if ((await navEntry.count()) > 0) {
        await clickThroughOverlay(page, navEntry, notes)
        await page.waitForTimeout(300)
      }
    }

    await page.waitForSelector('.dgc-section', { timeout: 10_000, state: 'attached' })
    notes.push('  ✓ the group-chat settings section rendered')
  } catch (error) {
    failures.push(
      'the group-chat settings section never rendered — the `settings.section` seat did not '
      + `produce a mountable component (${error instanceof Error ? error.message : String(error)})`,
    )
    return
  }

  try {
    // The list call is the first host round-trip the component makes. If it
    // failed, the component renders an error and no input.
    const input = page.locator('.dgc-input').first()
    if ((await input.count()) === 0) {
      const shown = (await page.locator('.dgc-error').first().innerText().catch(() => '')).trim()
      failures.push(`the room form did not render${shown === '' ? '' : ` — the host said: ${shown}`}`)
      return
    }

    await input.fill(roomName)
    await page.locator('button[type="submit"]').first().click()

    // Wait for the created room to come back from the host, which proves the
    // write landed *and* that the subsequent list call saw it.
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.dgc-room-name')].some((node) => node.textContent === name),
      roomName,
      { timeout: 10_000 },
    )
    notes.push(`  ✓ created "${roomName}" through the browser and read it back`)

    // Members: another entity, another nested round-trip, and a second chance
    // for the descriptor table to be wrong in a way only a real call reveals.
    const memberName = `${roomName}-m1`
    const row = page.locator('.dgc-room', { hasText: roomName }).first()
    await row.getByRole('button', { name: '成员' }).click()
    await row.locator('.dgc-member-input').fill(memberName)
    await row.getByRole('button', { name: '添加成员' }).click()
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.dgc-member-name')]
        .some((node) => (node.textContent ?? '').includes(name)),
      memberName,
      { timeout: 10_000 },
    )
    notes.push(`  ✓ added member "${memberName}" and read it back`)

    // The room row's count must agree with the list below it. This assertion
    // exists because the screenshot showed "0 名成员" beside a visible member
    // while every other assertion passed — a stale count is invisible to a DOM
    // query that looks in the right place.
    const countText = await row.innerText()
    if (!/1 名成员/.test(countText)) {
      failures.push(
        `the room row still shows a stale member count: expected "1 名成员" in ${JSON.stringify(countText.replace(/\s+/g, ' ').slice(0, 120))}`,
      )
    } else {
      notes.push("  ✓ the room row member count updated with the list")
    }

    // Capture the populated state. The run cleans up after itself, so the final
    // screenshot would otherwise show an empty list — evidence of nothing, which
    // is exactly the kind of "verified" this project refuses.
    const populated = resolve(out).replace(/\.png$/, '-populated.png')
    await page.screenshot({ path: populated, fullPage: true })
    notes.push(`screenshot (populated): ${populated}`)

    await row.getByRole('button', { name: new RegExp(`移除\\s*${memberName}`) }).click()
    await page.waitForFunction(
      (name) => ![...document.querySelectorAll('.dgc-member-name')]
        .some((node) => (node.textContent ?? '').includes(name)),
      memberName,
      { timeout: 10_000 },
    )
    notes.push(`  ✓ removed member "${memberName}"`)

    // Starting a room must reach the host and report what actually happened.
    // The host has no speaker installed — a speaker needs a model — so the
    // honest outcome is a refusal that says so. Asserting the refusal verifies
    // the whole RPC chain up to the model boundary, and pins the fact that this
    // path is refused rather than silently doing nothing.
    await row.getByRole('button', { name: new RegExp(`开始\\s*${roomName}`) }).click()
    await page.waitForSelector('.dgc-room-state', { timeout: 10_000, state: 'attached' })
    const stateText = (await row.locator('.dgc-room-state').first().innerText()).trim()
    if (!/speaker/i.test(stateText)) {
      failures.push(
        'starting a room did not report the missing speaker; the page said '
        + `${JSON.stringify(stateText.slice(0, 160))}`,
      )
    } else {
      notes.push('  ✓ starting a room reached the host and reported the model boundary')
    }

    // And delete the room, so the lab does not accumulate them across runs.
    // This also exercises the second write path.
    await row.getByRole('button', { name: new RegExp(`删除\\s*${roomName}`) }).click()
    await page.waitForFunction(
      (name) => ![...document.querySelectorAll('.dgc-room-name')].some((node) => node.textContent === name),
      roomName,
      { timeout: 10_000 },
    )
    notes.push(`  ✓ deleted "${roomName}" and saw it leave the list`)
  } catch (error) {
    failures.push(
      `the room round-trip failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Close whatever panel is covering the sidebar.
 *
 * Distinct from `dismissBlockingOverlay`, which handles *onboarding* modals:
 * this one is the platform's settings panel, left open by the previous step, and
 * its mask sits over the sidebar column — so the panellist icon is visible,
 * enabled, and impossible to click. The failure reads as "the icon does nothing"
 * for the third time in this project's short life, which is why the step is
 * explicit rather than folded into a retry.
 */
async function closePanels(page, notes) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await page.locator('[class*="_mask_"]').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  const close = page.getByRole('button', { name: /^(close|关闭)$/i }).first()
  if ((await close.count()) > 0 && await close.isVisible().catch(() => false)) {
    await close.click({ timeout: 3_000 }).catch(() => undefined)
    await page.waitForTimeout(400)
  }
  if ((await page.locator('[class*="_mask_"]').count()) > 0) {
    notes.push('  (a mask is still present after trying to close panels)')
  }
}

/**
 * Drive the tavern's world-book list: create one, see it come back, delete it.
 *
 * This is the second plugin's namespace and the second browser half, so a broken
 * descriptor table or a missing `inject` entry fails here rather than in the
 * group-chat section that already passes.
 */
async function verifyWorldBooks(page, notes, failures, out) {
  const bookName = `book-${Date.now().toString(36)}`

  try {
    // The tavern page was opened by the previous step and nothing has navigated
    // away since, so it should already be selected. This is a no-op then.
    const icon = page.locator('.dtv-icon').first()
    if ((await icon.count()) > 0 && (await page.locator('.dtv-page').count()) === 0) {
      await clickThroughOverlay(page, icon, notes)
    }
    await page.waitForSelector('.dtv-page', { timeout: 10_000, state: 'attached' })

    const input = page.locator('.dtv-book-name').first()
    if ((await input.count()) === 0) {
      const shown = (await page.locator('.dtv-error').first().innerText().catch(() => '')).trim()
      failures.push(`the world-book form did not render${shown === '' ? '' : ` — the host said: ${shown}`}`)
      return
    }

    await input.fill(bookName)
    await page.locator('.dtv-form button[type="submit"]').first().click()
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('.dtv-book .dtv-row-name')]
        .some((node) => node.textContent === name),
      bookName,
      { timeout: 10_000 },
    )
    notes.push(`  ✓ created world book "${bookName}" and read it back`)

    const populated = resolve(out).replace(/\.png$/, '-tavern.png')
    await page.screenshot({ path: populated, fullPage: true })
    notes.push(`screenshot (tavern, populated): ${populated}`)

    // Edit the book: add one entry, save it, then ask the engine why.
    const row = page.locator('.dtv-book', { hasText: bookName }).first()
    await row.getByRole('button', { name: new RegExp(`编辑\\s*${bookName}`) }).click()
    await page.waitForSelector('.dtv-editor', { timeout: 10_000, state: 'attached' })
    await row.getByRole('button', { name: '添加条目' }).click()
    await row.locator('.dtv-entry-keys').first().fill('sword')
    await row.locator('.dtv-entry-content').first().fill('A dull blade, and {{char}} knows it.')

    await row.locator('.dtv-save').click()
    await page.waitForFunction(
      () => [...document.querySelectorAll('.dtv-hint')].some((node) => (node.textContent ?? '').includes('已保存')),
      undefined,
      { timeout: 10_000 },
    )
    notes.push('  ✓ added an entry to the world book and saved it')

    // The tester: does the engine fire on a matching message, and does it say so?
    await row.locator('.dtv-sample').first().fill('I drew my sword.')
    await row.locator('.dtv-run-scan').click()
    await page.waitForSelector('.dtv-pre', { timeout: 10_000, state: 'attached' })
    const injected = (await row.locator('.dtv-pre').first().innerText()).trim()
    if (!injected.includes('A dull blade')) {
      failures.push(`the tester injected nothing for a matching message; it showed ${JSON.stringify(injected.slice(0, 120))}`)
    } else {
      notes.push('  ✓ the tester injected the entry for a matching message')
    }

    const reasons = await row.locator('.dtv-trace .dtv-badge').allInnerTexts()
    if (!reasons.includes('activated')) {
      failures.push(`the tester's trace did not report an activation; it reported ${JSON.stringify(reasons)}`)
    } else {
      notes.push(`  ✓ the trace reported ${reasons.join(', ')}`)
    }

    // Now the fields the editor gained later than the first five: a secondary
    // key with AND_ALL logic. If these inputs never reached the record, the
    // engine would still fire on the plain key and nothing above would look
    // wrong — so what follows asserts that the *secondary* rule decided.
    await row.locator('input[aria-label="条目 1 次级关键词"]').check()
    await row.locator('select[aria-label="条目 1 次级逻辑"]').selectOption('3')
    await row.locator('input[aria-label="条目 1 次关键词"]').fill('rusty')
    await row.locator('.dtv-save').click()
    await page.waitForFunction(
      () => [...document.querySelectorAll('.dtv-hint')].some((node) => (node.textContent ?? '').includes('已保存')),
      undefined,
      { timeout: 10_000 },
    )

    // A sample that satisfies the primary key but not the secondary one.
    // `AND_ALL` must refuse it, and say so.
    await row.locator('.dtv-sample').first().fill('I drew my sword.')
    await row.locator('.dtv-run-scan').click()
    // Wait for the trace to *change*, not merely to exist: `.dtv-pre` is already
    // on screen from the previous run, so waiting for it reads stale DOM and
    // asserts the previous answer. That is the same staleness the room row's
    // member count taught, one layer down.
    const gated = await page.waitForFunction(
      () => [...document.querySelectorAll('.dtv-trace .dtv-badge')].some((n) => n.textContent === 'secondary-failed'),
      undefined,
      { timeout: 10_000 },
    ).then(() => true).catch(() => false)
    if (!gated) {
      const refused = await row.locator('.dtv-trace .dtv-badge').allInnerTexts()
      failures.push(
        `a secondary key set to AND_ALL did not gate the entry; the trace reported ${JSON.stringify(refused)}`,
      )
    } else {
      notes.push('  ✓ a secondary key set to AND_ALL gated the entry (secondary-failed)')
    }

    // And a sample that satisfies both.
    await row.locator('.dtv-sample').first().fill('I drew my rusty sword.')
    await row.locator('.dtv-run-scan').click()
    await page.waitForFunction(
      () => [...document.querySelectorAll('.dtv-trace .dtv-badge')].some((n) => n.textContent === 'activated'),
      undefined,
      { timeout: 10_000 },
    )
    notes.push('  ✓ satisfying the secondary key activated the entry')

    // Book-level settings, proven the same way: entry 2's key exists *only* in
    // entry 1's content, so it can fire only if recursion is on — and recursion
    // is only on because the settings block above set it. The probe cannot pass
    // by accident, because without the setting there is nothing to match.
    await row.locator('input[aria-label="书 递归"]').check()
    await row.locator('input[aria-label="书 递归轮数"]').fill('2')
    await row.getByRole('button', { name: '添加条目' }).click()
    await row.locator('input[aria-label="条目 2 关键词"]').fill('blade')
    await row.locator('textarea[aria-label="条目 2 内容"]').fill('Rust never sleeps.')
    await row.locator('.dtv-save').click()
    await page.waitForFunction(
      () => [...document.querySelectorAll('.dtv-hint')].some((node) => (node.textContent ?? '').includes('已保存')),
      undefined,
      { timeout: 10_000 },
    )

    await row.locator('.dtv-sample').first().fill('I drew my rusty sword.')
    await row.locator('.dtv-run-scan').click()
    const recursed = await page.waitForFunction(
      () => (document.querySelector('.dtv-pre')?.textContent ?? '').includes('Rust never sleeps'),
      undefined,
      { timeout: 10_000 },
    ).then(() => true).catch(() => false)
    if (!recursed) {
      const injectedNow = (await row.locator('.dtv-pre').first().innerText().catch(() => '')).trim()
      failures.push(
        'the book-level recursion setting did not take effect: entry 2 keys on a word that '
        + `only appears in entry 1's content, and it never fired. Injected: ${JSON.stringify(injectedNow.slice(0, 160))}`,
      )
    } else {
      notes.push('  ✓ book-level recursion fired an entry whose key only exists in another entry\'s content')
    }

    const testerShot = resolve(out).replace(/\.png$/, '-tester.png')
    await page.screenshot({ path: testerShot, fullPage: true })
    notes.push(`screenshot (tester): ${testerShot}`)

    await row.getByRole('button', { name: new RegExp(`删除\\s*${bookName}`) }).click()
    await page.waitForFunction(
      (name) => ![...document.querySelectorAll('.dtv-book .dtv-row-name')]
        .some((node) => node.textContent === name),
      bookName,
      { timeout: 10_000 },
    )
    notes.push(`  ✓ deleted world book "${bookName}"`)
  } catch (error) {
    // Read what the page is showing. Without it a timeout says only that
    // something did not happen, which is the least useful half of the fact.
    const shown = (await page.locator('.dtv-error').first().innerText().catch(() => '')).trim()
    const books = await page.locator('.dtv-book .dtv-row-name').allInnerTexts().catch(() => [])
    failures.push(
      `the world-book round-trip failed: ${error instanceof Error ? error.message : String(error)}`
      + `${shown === '' ? '' : ` — the page says: ${shown}`}`
      + ` (books visible: ${books.length === 0 ? 'none' : books.join(', ')})`,
    )
  }
}

async function main() {
  const { url, out, timeout } = parseArgs(process.argv.slice(2))
  const chromium = await loadChromium()

  const failures = []
  const notes = []

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  // Console and page errors are the loudest signal a plugin failed: the platform
  // reports a bad slot registration as a harness banner and a console error, and
  // a swallowed exception in `apply` shows up nowhere else.
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout })

    // Clear any first-run overlay BEFORE touching anything. See the note on
    // dismissBlockingOverlay: an intercepted click is indistinguishable from a
    // dead control.
    const dismissed = await dismissBlockingOverlay(page)
    if (dismissed !== null) notes.push(`dismissed a blocking overlay via ${dismissed}`)
    await page.waitForTimeout(1_000)

    mkdirSync(dirname(resolve(out)), { recursive: true })
    await page.screenshot({ path: resolve(out).replace(/\.png$/, '-initial.png'), fullPage: true })

    // 1. The boot graph the host injected must contain our rows. This is the
    //    discovery step: if a package's `dsh.client` was not scanned, its row is
    //    absent here and nothing downstream can work.
    const boot = await page.evaluate(() => {
      const graph = globalThis.__DSH_BOOT__
      if (graph === undefined || graph === null) return null
      const entries = Array.isArray(graph.entries) ? graph.entries : []
      return { rev: graph.rev, ids: entries.map((entry) => entry.id) }
    })

    if (boot === null) {
      failures.push('window.__DSH_BOOT__ is absent — the page never received a boot graph')
    } else {
      notes.push(`boot graph rev ${boot.rev}, ${boot.ids.length} entries`)
      for (const id of EXPECTED_ENTRIES) {
        if (boot.ids.includes(id)) notes.push(`  ✓ ${id} is in the boot graph`)
        else failures.push(`${id} is NOT in the boot graph (ids seen: ${boot.ids.join(', ')})`)
      }
    }

    // 2. The factory must have materialized and rendered. A graph entry only
    //    proves the bundle is served; a DOM marker proves `apply` ran and the
    //    seat was claimed.
    for (const [label, selector] of Object.entries(MARKERS)) {
      if (label.includes('after click')) continue
      try {
        await page.waitForSelector(selector, { timeout: 10_000, state: 'attached' })
        notes.push(`  ✓ rendered: ${label} (${selector})`)
      } catch {
        failures.push(`nothing rendered for ${label} — expected ${selector}`)
      }
    }

    // 3. Clicking the panellist icon must select our `main` key. Two seats with
    //    the same string are what make a whole page work; if the id/key pairing
    //    is wrong, the icon renders and does nothing.
    const icon = page.locator('.dtv-icon').first()
    if ((await icon.count()) > 0) {
      try {
        await clickThroughOverlay(page, icon, notes)
        await page.waitForSelector(MARKERS['dsh-tavern page (after click)'], { timeout: 10_000, state: 'attached' })
        notes.push('  ✓ clicking the panellist icon opened the tavern page')
      } catch (error) {
        failures.push(
          'the panellist icon rendered but did not open the tavern page — '
          + 'check that `sidebar.panellist` id and the `main` key are the same string '
          + `(${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }

    // 4. The room manager: does a browser call actually reach the host?
    //
    //    This is the check that the descriptor table, the gateway, the host
    //    validator and the storage domain all line up. A descriptor naming a
    //    method that does not exist, a parameter in the wrong position, a
    //    non-JSON-lossless result — every one of them fails here and nowhere
    //    earlier, because this is the only place the whole chain is exercised.
    // The tavern panel is the selected one at this point, so its check runs
    // first. The group-chat check opens the settings panel and leaves a mask
    // over the sidebar; ordering the two the other way made the tavern step
    // depend on cleaning up after its predecessor, which is a dependency worth
    // not having when a cheaper ordering exists.
    await verifyWorldBooks(page, notes, failures, out)
    await verifyRoomManager(page, notes, failures, out)

    // 5. Screenshot regardless of outcome: when something fails, the picture is
    //    the fastest way to see what the DOM assertions could not describe.
    mkdirSync(dirname(resolve(out)), { recursive: true })
    await page.screenshot({ path: out, fullPage: true })
    notes.push(`screenshot: ${out}`)

    // Surface the harness failure banner if the platform rendered one.
    const banner = await page.evaluate(() => {
      const text = document.body?.innerText ?? ''
      const match = text.match(/Failed to load plugins[^\n]*/i)
      return match === null ? null : match[0]
    })
    if (banner !== null) failures.push(`the platform rendered a failure banner: ${banner}`)
  } finally {
    await browser.close()
  }

  if (consoleErrors.length > 0) {
    // Console errors are reported but do not fail the run on their own: the
    // platform emits some benign ones during boot, and a hard failure here
    // would train us to ignore the list.
    notes.push(`console errors (${consoleErrors.length}):`)
    for (const message of consoleErrors.slice(0, 10)) notes.push(`    ${message}`)
  }

  console.log(notes.join('\n'))
  if (failures.length > 0) {
    console.error('\nbrowser verification FAILED:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('\nbrowser verification OK')
}

try {
  await main()
} catch (error) {
  console.error(`browser-verify: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
