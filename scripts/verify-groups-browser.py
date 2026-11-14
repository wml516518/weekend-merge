"""Controlled local browser acceptance. Start tests/helpers/group-browser-server.ts via with_server.py.
No fetch mocks, no model/weather credentials, no capability values printed or captured.
"""
import json
import re
import sys
import traceback
from datetime import datetime, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

def redact_capabilities(value):
    return re.sub(r'((?:#|%23)(?:invite|recover)(?:=|%3d))[^\s\'"<>]+', r'\1[REDACTED]', str(value), flags=re.IGNORECASE)

def report_failure(kind, value, tb):
    # Playwright's navigation call log and chained exceptions include full URLs.
    # Format once, then redact the entire traceback before writing any of it.
    sys.stderr.write(redact_capabilities(''.join(traceback.format_exception(kind, value, tb))))

sys.excepthook = report_failure

BASE = 'http://127.0.0.1:8791'
OUT = Path('output/playwright')
OUT.mkdir(parents=True, exist_ok=True)
day = datetime.now() + timedelta(days=1)
while day.weekday() != 5:
    day += timedelta(days=1)
DATE = day.strftime('%Y-%m-%d')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    contexts = []
    failures = []
    checks = []
    def context():
        ctx = browser.new_context(viewport={'width': 1365, 'height': 1000}, reduced_motion='reduce', accept_downloads=True, permissions=['clipboard-read', 'clipboard-write'])
        # Deterministic offline fonts/assets: local application/API responses remain real.
        ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(BASE) else route.abort())
        contexts.append(ctx)
        return ctx
    def page_for(ctx, url=BASE):
        page = ctx.new_page()
        page.on('pageerror', lambda error: failures.append(redact_capabilities(error)))
        page.goto(url, wait_until='domcontentloaded')
        page.wait_for_load_state('networkidle')
        return page
    def screenshot(page, name):
        page.screenshot(path=str(OUT / name), full_page=True, mask=[page.get_by_label(label, exact=True) for label in ['邀请链接', '我的恢复链接', '管理恢复链接']])
    def data(ctx, group_id):
        response = ctx.request.get(f'{BASE}/api/groups/{group_id}')
        assert response.status == 200
        return response.json()
    def create(ctx, name, count):
        page = page_for(ctx)
        # Reconnaissance before form interaction: only visible control names, never input values.
        assert '创建并邀请' in page.locator('button').all_text_contents()
        page.get_by_label('计划名称', exact=True).fill(name)
        page.get_by_label('我的昵称', exact=True).fill('发起人')
        page.get_by_role('combobox', name='参与人数', exact=False).select_option(str(count))
        page.get_by_label('日期', exact=True).fill(DATE)
        page.get_by_role('button', name='创建并邀请', exact=True).click()
        try:
            expect(page.get_by_label('邀请链接', exact=True)).to_be_visible()
        except AssertionError:
            print('Create failure alerts:', redact_capabilities(page.get_by_role('alert').all_text_contents()), flush=True)
            raise
        invite = page.get_by_label('邀请链接', exact=True).input_value()
        personal = page.get_by_label('我的恢复链接', exact=True).input_value()
        owner = page.get_by_label('管理恢复链接', exact=True).input_value()
        group_id = page.url.split('#group=')[1]
        return page, group_id, invite, personal, owner
    def join(invite, nickname):
        ctx = context()
        page = page_for(ctx, invite)
        assert '#invite=' not in page.url
        page.get_by_label('加入昵称', exact=True).fill(nickname)
        page.get_by_role('button', name='加入计划', exact=True).click()
        expect(page.get_by_role('button', name='填写我的偏好', exact=True)).to_be_visible()
        return ctx, page
    def form(page):
        page.get_by_role('button', name='填写我的偏好', exact=True).click()
        for name in ['展览', '咖啡']:
            control = page.get_by_role('checkbox', name=name, exact=True)
            if not control.is_checked():
                control.focus()
                control.press('Space')
            expect(control).to_be_checked()
    def submit(page):
        page.get_by_role('button', name='提交我的偏好', exact=True).click()
        expect(page.get_by_role('button', name='提交我的偏好', exact=True)).not_to_be_visible()

    owner2 = context()
    home = page_for(owner2)
    screenshot(home, 'task5-home-desktop.png')
    owner2page, id2, invite2, personal2, recovery2 = create(owner2, '双人独立计划', 2)
    member2, member2page = join(invite2, '参与者乙')
    form(owner2page)
    wish = owner2page.get_by_label('一句话愿望（可选）', exact=True)
    wish.fill('尚未保存的本地草稿')
    owner2page.wait_for_timeout(3400)
    expect(wish).to_have_value('尚未保存的本地草稿')
    current = data(owner2, id2)
    member = current['myMembers'][0]
    preferences = {'interests': ['展览', '咖啡'], 'pace': '轻松', 'walkingLimitKm': 3, 'indoorPreference': '室内优先', 'foodTags': [], 'budgetStyle': '平衡', 'avoid': [], 'wish': '服务器更新的草稿'}
    response = owner2.request.post(f'{BASE}/api/groups/{id2}/preferences', headers={'Origin': BASE}, data={'memberId': member['id'], 'version': member['version'], 'preferences': preferences, 'submit': False, 'idempotencyKey': 'browser-conflict'})
    assert response.status == 200
    expect(owner2page.get_by_role('button', name='同步服务器草稿', exact=True)).to_be_visible(timeout=7000)
    owner2page.get_by_role('button', name='同步服务器草稿', exact=True).click()
    expect(owner2page.get_by_label('一句话愿望（可选）', exact=True)).to_have_value('服务器更新的草稿')
    checks.append('dirty draft survives poll; same-identity server conflict requires explicit fresh sync')
    print('PASS dirty-form and explicit sync', flush=True)
    submit(owner2page)
    assert data(owner2, id2)['state'] == 'collecting'
    assert 'job' not in data(owner2, id2)
    form(member2page)

    owner6 = context()
    owner6page, id6, invite6, personal6, recovery6 = create(owner6, '六人独立计划', 6)
    members6 = [join(invite6, '成员' + str(i) + ('很长的昵称用于窄屏检查' if i == 5 else '')) for i in range(1, 6)]
    expect(owner6page.get_by_role('list', name='参与席位')).to_be_visible()
    owner6page.wait_for_timeout(3300)
    screenshot(owner6page, 'task5-six-seats-desktop.png')
    owner6page.set_viewport_size({'width': 360, 'height': 800})
    screenshot(owner6page, 'task5-six-seats-360.png')
    assert owner6page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    owner6page.keyboard.press('Tab')
    assert owner6page.evaluate('document.activeElement !== document.body')
    form(owner6page)
    screenshot(owner6page, 'task5-preferences-360.png')
    assert owner6page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    submit(owner6page)
    for ctx, page in members6[:-1]:
        form(page)
        submit(page)
    assert data(owner6, id6)['state'] == 'collecting'
    assert 'job' not in data(owner6, id6)
    form(members6[-1][1])
    submit(member2page)
    submit(members6[-1][1])
    owner6page.wait_for_timeout(1400)
    runs = owner2.request.get(BASE + '/__test/runs').json()
    assert set(runs['started']) == {id2, id6} and not runs['completed']
    assert data(owner2, id2)['state'] == 'running'
    assert data(owner6, id6)['state'] == 'running'
    assert member2.request.get(f'{BASE}/api/groups/{id6}').status == 403
    assert len(data(member2, id2)['myMembers']) == 1
    checks.append('2 and 6 independent cookie contexts; no job before final submit; concurrent isolated groups')
    print('PASS independent2/6 and two running groups', flush=True)

    # A third independent plan verifies queue capacity and explicit same-device blank identity.
    handoff = context()
    handoff_page, id3, invite3, _, _ = create(handoff, '同设备交接计划', 2)
    handoff_page.get_by_role('button', name='交给同设备另一位', exact=True).click()
    handoff_page.get_by_label('加入昵称', exact=True).fill('交接新身份')
    handoff_page.get_by_role('button', name='确认新增独立成员', exact=True).click()
    expect(handoff_page.get_by_role('combobox', name='当前填写身份', exact=False)).to_be_visible()
    own = data(handoff, id3)['myMembers']
    assert len(own) == 2 and all(not member.get('preferences') for member in own)
    for member in own:
        handoff_page.get_by_role('combobox', name='当前填写身份', exact=False).select_option(member['id'])
        form(handoff_page)
        submit(handoff_page)
    assert data(handoff, id3)['state'] == 'queued'
    assert len(handoff.request.get(BASE + '/__test/runs').json()['started']) == 2
    checks.append('handoff creates separate blank identity; third submitted group waits behind capacity2')

    owner2.request.post(BASE + '/__test/release')
    expect(owner2page.get_by_role('region', name='共同规划结果')).to_be_visible(timeout=12000)
    expect(owner6page.get_by_role('region', name='共同规划结果')).to_be_visible(timeout=12000)
    expect(member2page.get_by_role('region', name='共同规划结果')).to_be_visible(timeout=12000)
    assert len(data(owner6, id6)['candidates']) == 3
    assert not member2page.get_by_role('button', name='确认最终行程', exact=True).count()
    for ctx, gid in [(owner2, id2), (owner6, id6)]:
        view = data(ctx, gid)
        assert any(entry['event']['type'] == 'run.degraded' for entry in view['job']['events'])
    checks.append('real worker rule fallback persisted honestly; three legal candidates; member results read-only')

    for page in [owner2page, owner6page]:
        page.get_by_role('button', name='选择方案 ', exact=False).first.click()
    owner6page.get_by_role('button', name='确认最终行程', exact=True).click()
    expect(owner6page.get_by_text('6 人总计', exact=True)).to_be_visible()
    screenshot(owner6page, 'task5-final-six-360.png')
    assert owner6page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    with owner6page.expect_download() as download:
        owner6page.get_by_role('button', name='导出行程长图', exact=True).click()
    download.value.save_as(str(OUT / 'task5-six-person-export.png'))
    owner6page.get_by_role('button', name='复制只读分享链接', exact=True).click()
    owner6page.wait_for_timeout(100)
    shared_url = owner6page.evaluate('navigator.clipboard.readText()')
    assert '#share=' in shared_url
    share_page = page_for(context(), shared_url)
    expect(share_page.get_by_text('6 人总计', exact=True)).to_be_visible()
    owner2page.get_by_role('button', name='确认最终行程', exact=True).click()
    expect(member2page.get_by_text('2 人总计', exact=True)).to_be_visible(timeout=7000)
    screenshot(owner2page, 'task5-final-two-desktop.png')
    checks.append('owner selections/finalization synchronize; six-person PNG download and mobile final map')

    personal_ctx = context()
    personal_page = page_for(personal_ctx, personal2)
    expect(personal_page.get_by_text('2 人总计', exact=True)).to_be_visible()
    assert '#recover=' not in personal_page.url
    personal_view = data(personal_ctx, id2)
    assert not personal_view['canManage'] and len(personal_view['myMembers']) == 1
    manager_ctx = context()
    manager_page = page_for(manager_ctx, recovery2)
    expect(manager_page.get_by_text('2 人总计', exact=True)).to_be_visible()
    manager_view = data(manager_ctx, id2)
    assert manager_view['canManage'] and manager_view['myMembers'] == []
    owner2page.reload()
    expect(owner2page.get_by_text('2 人总计', exact=True)).to_be_visible()
    assert len(owner2.request.get(BASE + '/__test/runs').json()['started']) == 3
    checks.append('fragment removal; personal and management recovery roles separate; reload never rebills')
    assert all(not any('invite=' in str(value) or 'recover=' in str(value) for value in ctx.storage_state()['origins']) for ctx in contexts)
    assert not failures, failures
    (OUT / 'task5-browser-evidence.json').write_text(json.dumps({'checks': checks, 'contexts': len(contexts), 'pageErrors': failures, 'provider': 'controlled gate + real default rule runner; no external requests', 'date': DATE}, ensure_ascii=False, indent=2))
    print(json.dumps({'checksPassed': len(checks), 'contexts': len(contexts), 'pageErrors': 0, 'screenshots': str(OUT)}, ensure_ascii=False))
    for ctx in contexts:
        ctx.close()
    browser.close()
