import csv, sys
rows = list(csv.DictReader(open(sys.argv[1])))
print(sum(float(r['amount']) for r in rows))
