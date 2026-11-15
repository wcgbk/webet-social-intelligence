#!/usr/bin/env python3
"""Grade a replay-sharp card with grade85 rules.

Odds API names (CSU, Mt., San Diego St) sometimes miss ESPN finals.
When grade_one returns unmatched, retry once with those aliases.
Production grading is not changed. Usage:
  python3 tools/omega-v2/grade-sharp.py OUT.json
"""
import datetime
import json
import math
import os
import re
import sys

os.chdir('/workspace/force3-1113/lowpay')
exec(open('lowpay.py').read())  # gradec, grade_one, games, dec


def expand_name(name):
    text = str(name or '')
    text = text.replace('Mt.', 'Mount').replace('Mt ', 'Mount ')
    text = re.sub(r'\(\s*MD\s*\)', 'Maryland', text, flags=re.I)
    text = re.sub(r'\bCSU\b', 'Cal State', text)
    text = re.sub(r"\bSt\.?\b(?!\s*Mary)", 'State', text)
    return text


def expand_pick(pick):
    out = dict(pick)
    for key in ('homeTeam', 'awayTeam', 'matchup', 'side', 'pick'):
        if out.get(key):
            out[key] = expand_name(out[key])
    return out


def grade_pick(pick):
    odds = int(str(pick['odds']).replace('+', ''))
    row = dict(pick, a=odds)
    graded = gradec(row, pick['stakeUsd'])
    if graded['result'] != 'unmatched':
        return graded, False
    alias = expand_pick(pick)
    ct = datetime.datetime.fromisoformat(alias['commenceTime'].replace('Z', '+00:00')).timestamp()
    window = [
        game for game in games
        if abs(datetime.datetime.fromisoformat(game['eventDate'].replace('Z', '+00:00')).timestamp() - ct) <= 20 * 3600
    ]
    again = grade_one({
        'market': alias['market'],
        'pick': alias.get('side') or alias.get('pick'),
        'line': alias['line'],
        'homeTeam': alias.get('homeTeam'),
        'awayTeam': alias.get('awayTeam'),
        'matchup': alias.get('matchup'),
        'sport': alias.get('sport'),
        'odds': odds,
        'stakeUsd': pick['stakeUsd'],
    }, window)
    if again['result'] == 'unmatched':
        return graded, False
    return again, True


def main():
    path = sys.argv[1]
    card = json.load(open(path))
    tot = dict(sW=0, sL=0, sP=0, sProf=0.0, sRisk=0, pW=0, pL=0, pProf=0.0, pRisk=0, days3=0, days=0, neg=0, fav300=0)
    aliases = []
    for date, day in card.items():
        tot['days'] += 1
        parlay = day.get('parlay')
        tot['days3'] += int(len(day['picks']) == 3 and parlay is not None and len(parlay.get('legs') or []) == 3)
        results = []
        for pick in day['picks']:
            odds = int(str(pick['odds']).replace('+', ''))
            tot['fav300'] += odds < -300
            tot['neg'] += float(str(pick.get('ev') or 0).replace('%', '')) < 0
            graded, used_alias = grade_pick(pick)
            if used_alias:
                aliases.append((date, pick.get('side'), graded['result']))
            results.append(graded['result'])
            if graded['result'] in ('win', 'loss', 'push'):
                tot['sW'] += graded['result'] == 'win'
                tot['sL'] += graded['result'] == 'loss'
                tot['sP'] += graded['result'] == 'push'
                tot['sProf'] += graded['profit'] or 0
                tot['sRisk'] += pick['stakeUsd']
        profit = None
        if parlay and date != '2026-11-14':
            stake = parlay['stakeUsd']
            decimals = [dec(int(str(pick['odds']).replace('+', ''))) for pick in day['picks']]
            if any(result in ('pending', 'unmatched') for result in results):
                profit = None
            elif 'loss' in results:
                profit = -stake
            else:
                profit = stake * (math.prod(decimal for decimal, result in zip(decimals, results) if result != 'push') - 1)
            if profit is not None:
                tot['pRisk'] += stake
                tot['pProf'] += profit
                tot['pW'] += profit > 0
                tot['pL'] += profit < 0
    tot['total'] = round(tot['sProf'] + tot['pProf'])
    tot['risk'] = tot['sRisk'] + tot['pRisk']
    tot['sProf'] = round(tot['sProf'])
    tot['pProf'] = round(tot['pProf'])
    tot['aliasRows'] = len(aliases)
    print(json.dumps(tot))
    if '-v' in sys.argv:
        for row in aliases:
            print('alias', row)


if __name__ == '__main__':
    main()
