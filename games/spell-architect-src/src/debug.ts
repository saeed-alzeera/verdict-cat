// Test/debug hooks: lets automated tests (and curious players) poke at the running game from the console.
import { checkAttach, newNode, findNode, walk, compileSpell, spellCost } from './core/spell';
import { RUNES, RUNE_BY_ID } from './data/runes';
import { HostNet, GuestNet } from './net/rtc';
import { generateRewards } from './game/rewards';
import { store } from './core/save';
import { ui } from './ui/ui';
import { planFor } from './game/rounds';
import * as shop from './game/shop';

(window as unknown as Record<string, unknown>).__SA = { checkAttach, newNode, findNode, walk, compileSpell, spellCost, RUNES, RUNE_BY_ID, generateRewards, store, ui, planFor, shop, HostNet, GuestNet };
