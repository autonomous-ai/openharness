"""Small hand-built instances for the tests: every expected value in the tests is worked out by hand from these."""


def model(id, engine='claude', cost=1, quality=3, speed=1.0, **extra):
    q = quality if isinstance(quality, dict) else {'default': quality}
    return {'id': id, 'engine': engine, 'cost': cost, 'quality': q, 'speed': speed, **extra}


def machine(id, slots=1, engines=('claude',)):
    return {'id': id, 'name': id, 'slots': slots, 'engines': list(engines)}


def task(id, minutes=60, floor=1, deps=(), **extra):
    return {'id': id, 'title': id, 'minutes': minutes, 'floor': floor, 'deps': list(deps), **extra}


def instance(tasks, machines, models, accounts=()):
    return {'tasks': list(tasks), 'machines': list(machines), 'models': list(models), 'accounts': list(accounts)}
