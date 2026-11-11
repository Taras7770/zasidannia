// Потоковий розбір TSV: поля в лапках, подвоєні лапки, переноси рядків усередині поля.
export class TsvParser {
  constructor(onRow) {
    this.buf = '';
    this.onRow = onRow;
    this.bad = 0;
  }
  push(chunk) {
    this.buf += chunk;
    this._drain(false);
  }
  end() {
    this._drain(true);
    this.buf = '';
  }
  _drain(final) {
    const s = this.buf;
    const n = s.length;
    let i = 0;
    let rowStart = 0;
    let fields = [];
    const MAXQ = 200000;
    outer: while (i < n || (final && fields.length)) {
      let val;
      if (i >= n) {
        val = '';
      } else if (s.charCodeAt(i) === 34) {
        let j = i + 1;
        let seg = j;
        let parts = null;
        for (;;) {
          const q = s.indexOf('"', j);
          if (q === -1 || q - i > MAXQ) {
            if ((q === -1 && !final && n - i <= MAXQ)) break outer; // чекаємо на дані
            // зіпсований запис: пропускаємо до кінця рядка
            this.bad++;
            const nl = s.indexOf('\n', i);
            if (nl === -1) {
              rowStart = n;
              fields = [];
              i = n;
              break outer;
            }
            i = nl + 1;
            rowStart = i;
            fields = [];
            continue outer;
          }
          if (q + 1 >= n && !final) break outer;
          if (s.charCodeAt(q + 1) === 34) {
            (parts || (parts = [])).push(s.slice(seg, q + 1));
            j = q + 2;
            seg = j;
            continue;
          }
          val = parts ? parts.join('') + s.slice(seg, q) : s.slice(seg, q);
          i = q + 1;
          break;
        }
        // текст після закритої лапки до роздільника (зіпсовані дані)
        if (i < n) {
          const c = s.charCodeAt(i);
          if (c !== 9 && c !== 10 && c !== 13) {
            const t = s.indexOf('\t', i);
            const l = s.indexOf('\n', i);
            let e = t === -1 ? l : l === -1 ? t : Math.min(t, l);
            if (e === -1) {
              if (!final) break outer;
              e = n;
            }
            val += s.slice(i, e);
            i = e;
          }
        }
      } else {
        const t = s.indexOf('\t', i);
        const l = s.indexOf('\n', i);
        let e = t === -1 ? l : l === -1 ? t : Math.min(t, l);
        if (e === -1) {
          if (!final) break outer;
          e = n;
        }
        val = s.slice(i, e);
        i = e;
        if (val.charCodeAt(val.length - 1) === 13) val = val.slice(0, -1);
      }
      fields.push(val);
      if (i >= n) {
        if (!final) break outer;
        this.onRow(fields);
        fields = [];
        rowStart = n;
        break;
      }
      let c = s.charCodeAt(i);
      if (c === 9) {
        i++;
        if (i >= n && final) fields.push('');
        continue;
      }
      if (c === 13) {
        if (i + 1 >= n && !final) break outer;
        i++;
        c = s.charCodeAt(i);
      }
      if (c === 10 || i >= n) {
        i++;
        this.onRow(fields);
        fields = [];
        rowStart = Math.min(i, n);
        continue;
      }
    }
    this.buf = s.slice(rowStart);
  }
}
