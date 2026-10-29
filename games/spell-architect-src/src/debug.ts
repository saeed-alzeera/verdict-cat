// Test/debug hooks: lets automated tests (and curious players) poke at the running game from the console.
import { checkAttach, newNode, findNode, walk, compileSpell, spellCost } from './core/spell';
import { RUNES, RUNE_BY_ID } from './data/runes';
import { HostNet, GuestNet } from './net/rtc';
import { generateRewards } from './game/rewards';
import { store } from './core/save';
import { ui } from './ui/ui';
import { planFor } from './game/rounds';
import * as shop from './game/shop';
import { spawnEnemy, playerScale } from './game/enemies';
import { TEXTURE_KEYS } from './gfx/textures';
import * as rituals from './game/rituals';
import * as runes from './data/runes';

(window as unknown as Record<string, unknown>).__SA = { checkAttach, newNode, findNode, walk, compileSpell, spellCost, RUNES, RUNE_BY_ID, generateRewards, store, ui, planFor, shop, HostNet, GuestNet, spawnEnemy, playerScale, TEXTURE_KEYS, rituals, runes };
