const {
  assoc,
  compose,
  pickAll,
  pluck,
  equals,
  init,
  concat,
  without,
  addIndex,
  range,
  splitAt,
  tail,
  indexOf,
  last,
  splitWhen,
  lt,
  objOf,
  flatten,
  zip,
  median,
  prop,
  isNil,
  map,
} = require("ramda")

class BPT {
  constructor(order = 4, sort_fields = "number", kv, onCommit) {
    this.kv = kv
    this.onCommit = onCommit
    this.order = order
    this.sort_fields = sort_fields
    this.max_vals = this.order - 1
    this.min_vals = Math.ceil(this.order / 2) - 1
  }
  get = async (key, stats) => stats?.[key] ?? (await this.kv.get(key))
  put = async (key, val, stats) => {
    if (!isNil(stats)) {
      stats[key] = val
    } else {
      await this.kv.put(key, val)
    }
  }
  del = async (key, stats) => {
    if (!isNil(stats)) {
      stats[key] = { __del__: true }
    } else {
      await this.kv.del(key)
    }
  }
  putData = async (key, val, stats) => {
    if (!isNil(stats)) {
      stats[`data/${key}`] = val
    } else {
      await this.put(`data/${key}`, val, stats)
    }
  }
  delData = async (key, stats) => {
    if (!isNil(stats)) {
      stats[`data/${key}`] = { __del__: true }
    } else {
      await this.del(`data/${key}`, stats)
    }
  }
  putNode = async (node, stats) => await this.put(node.id, node, stats)
  data = async (key, cache = {}, stats) => {
    if (typeof cache[key] !== "undefined") return { key, val: cache[key] }
    let _data = (await this.get(`data/${key}`, stats)) ?? null
    cache[key] = _data
    return { key, val: _data }
  }
  root = async stats => (await this.get("root", stats)) ?? null
  setRoot = async (id, stats) => (await this.put("root", id, stats)) ?? null
  isOver = (node, plus = 0) => node.vals.length + plus > this.max_vals
  isUnder = (node, plus = 0) => node.vals.length + plus < this.min_vals
  wrap = (val, key) => {
    let obj = { val }
    if (!isNil(val.__id__)) obj.key = val.__id__
    if (!isNil(key)) obj.key = key
    return obj
  }

  comp(a, b, null_last = false) {
    if (typeof this.sort_fields === "string") {
      return a.val === b.val ? 0 : a.val < b.val ? 1 : -1
    } else {
      for (const v of this.sort_fields) {
        const va = v[0] === "__id__" ? a.key : a.val[v[0]]
        const vb = v[0] === "__id__" ? b.key : b.val[v[0]]
        if (va !== vb) {
          return (
            (isNil(va)
              ? (v[1] === "desc" ? -1 : 1) * (null_last ? -1 : 1)
              : isNil(vb)
              ? (v[1] === "desc" ? -1 : 1) * (null_last ? 1 : -1)
              : va < vb
              ? 1
              : -1) * (v[1] === "desc" ? -1 : 1)
          )
        }
      }
      return 0
    }
  }

  async id(stats) {
    const count = ((await this.get("count", stats)) ?? -1) + 1
    await this.put("count", count, stats)
    return count.toString()
  }

  async init(key, stats) {
    let new_node = {
      leaf: true,
      id: await this.id(stats),
      vals: [key],
      parent: null,
      next: null,
      prev: null,
    }
    await this.putNode(new_node, stats)
    await this.setRoot(new_node.id, stats)
  }

  async search(val, key, stats) {
    let node = await this.get(key ?? (await this.root(stats)) ?? "0", stats)
    if (isNil(node)) return null
    if (node.leaf) return node
    let i = 0
    for (const v of node.vals) {
      if (isNil(val) || this.comp(val, node.leaf ? v : this.wrap(v)) === 1) {
        return await this.search(val, node.children[i], stats)
      }
      i++
    }
    return await this.search(val, node.children[i], stats)
  }

  async read(key) {
    let stats = {}
    return { key, val: (await this.searchByKey(key, stats))[0] }
  }

  async getVals(node, vals, index = 0, opt, cache = {}, inRange = null, stats) {
    for (let i = index; i < node.vals.length; i++) {
      const v = node.vals[i]
      const val = await this.data(v, cache, stats)
      if (!isNil(opt.endAt)) {
        if (this.comp(val, opt.endAt, true) < 0) return
      } else if (!isNil(opt.endBefore)) {
        if (this.comp(val, opt.endBefore) <= 0) return
      }
      vals.push({ key: v, val })
      if (!isNil(opt.limit) && vals.length === opt.limit) return
    }
    if (!isNil(node.next)) {
      const next = await this.get(node.next, stats)
      await this.getVals(next, vals, 0, opt, cache, null, stats)
    }
  }

  async findIndex(_index, node, val, cache, stats) {
    let index = _index
    let isPrev = false
    if (_index === 0) {
      isPrev = !isNil(node.prev)
    } else {
      _index ??= node.vals.length
      for (let i = _index - 1; i >= 0; i--) {
        const _val = await this.data(node.vals[i], cache, stats)
        if (this.comp(_val, val) !== 0) break
        index = i
        if (i === 0) isPrev = !isNil(node.prev)
      }
    }
    if (isPrev) {
      let prev = await this.get(node.prev, stats)
      const [new_index, new_node] = await this.findIndex(
        null,
        prev,
        val,
        cache,
        stats
      )
      return !isNil(new_index) ? [new_index, new_node] : [_index, node]
    } else {
      return [index, node]
    }
  }

  async findLastIndex(_index, node, val, cache, stats) {
    let index = null
    let isNext = false
    if (_index >= node.vals.length - 1) {
      isNext = !isNil(node.next)
    } else {
      for (let i = _index + 1; i < node.vals.length; i++) {
        const _val = await this.data(node.vals[i], cache, stats)
        if (this.comp(_val, val) !== 0) {
          index = i
          break
        }
        if (i === node.vals.length - 1) isNext = !isNil(node.next)
      }
    }
    if (isNext) {
      let next = await this.get(node.next, stats)
      const [new_index, new_node] = await this.findLastIndex(
        -1,
        next,
        val,
        cache,
        stats
      )
      return !isNil(new_index) ? [new_index, new_node] : [_index, node]
    } else {
      return [index, node]
    }
  }

  async findLastGtIndex(_index, node, val, cache, stats) {
    let index = null
    let isNext = false
    if (_index >= node.vals.length - 1) {
      isNext = !isNil(node.next)
    } else {
      for (let i = _index + 1; i < node.vals.length; i++) {
        const _val = await this.data(node.vals[i], cache, stats)
        if (this.comp(_val, val) === -1) {
          index = i
          break
        }
        if (i === node.vals.length - 1) isNext = !isNil(node.next)
      }
    }
    if (isNext) {
      let next = await this.get(node.next, stats)
      const [new_index, new_node] = await this.findLastGtIndex(
        -1,
        next,
        val,
        cache,
        stats
      )
      return !isNil(new_index) ? [new_index, new_node] : [_index, node]
    } else {
      return [index, node]
    }
  }

  async range(opt) {
    let stats = {}
    let start = opt.startAt ?? opt.startAfter
    const first_node = !isNil(start)
      ? await this.search(start, undefined, stats)
      : await this.search(undefined, undefined, stats)
    if (isNil(first_node)) return []
    let vals = []
    let cache = {}
    let index = 0
    let _node = first_node
    let _index = index
    if (!isNil(start)) {
      let [index, smaller, greater] = await this.binarySearch(
        first_node,
        start,
        cache,
        stats
      )
      if (!isNil(opt.startAt)) {
        _index = index
        if (!isNil(greater)) {
          _index = greater
        } else if (!isNil(index)) {
          const [new_index, new_node] = await this.findIndex(
            _index,
            first_node,
            start,
            cache,
            stats
          )
          if (!isNil(new_index)) {
            _index = new_index
            _node = new_node
          }
        } else if (!isNil(smaller) && !isNil(first_node.next)) {
          const next = await this.get(first_node.next, stats)
          const [new_index, new_node] = await this.findLastGtIndex(
            -1,
            next,
            start,
            cache,
            stats
          )
          if (!isNil(new_index)) {
            _index = new_index
            _node = new_node
          }
        }
      } else if (!isNil(opt.startAfter)) {
        _index = null
        if (!isNil(greater)) {
          _index = greater
        } else if (!isNil(index)) {
          const [new_index, new_node] = await this.findLastIndex(
            _index,
            first_node,
            start,
            cache,
            stats
          )
          if (!isNil(new_index)) {
            _index = new_index
            _node = new_node
          }
        } else if (!isNil(smaller) && !isNil(first_node.next)) {
          const next = await this.get(first_node.next, stats)
          const [new_index, new_node] = await this.findLastGtIndex(
            -1,
            next,
            start,
            cache,
            stats
          )
          if (!isNil(new_index)) {
            _index = new_index
            _node = new_node
          }
        }
      }
    }
    if (!isNil(_index))
      await this.getVals(_node, vals, _index, opt, cache, null, stats)
    return vals
  }

  async searchByKey(key, stats) {
    const val = await this.data(key, undefined, stats)
    if (isNil(val.val)) return [null, null, null]
    let node = await this.search(val, undefined, stats)
    if (isNil(node)) return [val, null, null]
    return [val, ...(await this.searchNode(node, key, val, true, stats))]
  }

  async binarySearch(node, val, cache = {}, stats) {
    let left = 0
    let right = node.vals.length - 1
    while (left <= right) {
      let mid = Math.floor((left + right) / 2)
      let midval = await this.data(node.vals[mid], cache, stats)
      if (this.comp(midval, val) === 0) {
        return [mid, null, null]
      } else if (this.comp(midval, val) === 1) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }
    return [
      null,
      right >= 0 ? right : null,
      left < node.vals.length ? left : null,
    ]
  }

  async searchNode(node, key, val, first = false, cache = {}, stats) {
    let start = 0
    let greater = null
    let smaller = null
    if (first) {
      ;[start, smaller, greater] = await this.binarySearch(
        node,
        val,
        cache,
        stats
      )
    }
    let isPrev = start === 0
    if (start === null) return [null, null]
    if (start > 0) {
      for (let i = start - 1; i >= 0; i--) {
        const v = node.vals[i]
        if (v === key) return [i, node]
        const _val = await this.data(v, cache, stats)
        if (this.comp(_val, val) === 1) break
        if (i === 0) isPrev = true
      }
    }
    for (let i = 0; i < node.vals.length; i++) {
      const v = node.vals[i]
      if (v === key) return [i, node]
      const _val = await this.data(v, cache, stats)
      if (this.comp(val, _val) === 1) {
        if (isPrev) break
        return [null, null]
      }
    }
    return isPrev && !isNil(node.prev)
      ? await this.searchNode(
          await this.get(node.prev, stats),
          key,
          val,
          false,
          cache,
          stats
        )
      : [null, null]
  }

  async rmIndex(val_index, child_index, node, stats) {
    node.vals.splice(val_index, 1)
    node.children.splice(child_index, 1)
    if (node.vals.length === 0 || (!isNil(node.parent) && this.isUnder(node))) {
      if (!isNil(node.parent)) {
        let parent = await this.get(node.parent, stats)
        let index = indexOf(node.id, parent.children)
        let isMerged = false
        const isPrev = index > 0
        const isNext = index + 1 < parent.children.length
        let prev = null
        let next = null
        if (isPrev) {
          prev = await this.get(parent.children[index - 1], stats)
          if (!this.isUnder(prev, -1)) {
            node.vals.unshift(parent.vals[index - 1])
            node.children.unshift(prev.children.pop())
            parent.vals[index - 1] = prev.vals.pop()
            await this.putNode(node, stats)
            await this.putNode(prev, stats)
            await this.putNode(parent, stats)
            let child = await this.get(node.children[0], stats)
            child.parent = node.id
            await this.putNode(child, stats)
            isMerged = true
          }
        }
        if (!isMerged && isNext) {
          next = await this.get(parent.children[index + 1], stats)
          if (!this.isUnder(next, -1)) {
            node.vals.push(parent.vals[index])
            node.children.push(next.children.shift())
            parent.vals[index] = next.vals.shift()
            await this.putNode(node, stats)
            await this.putNode(next, stats)
            await this.putNode(parent, stats)
            let child = await this.get(last(node.children), stats)
            child.parent = node.id
            await this.putNode(child, stats)
            isMerged = true
          }
        }
        if (!isMerged && isPrev) {
          if (!this.isOver(prev, node.vals.length + 1)) {
            prev.children = concat(prev.children, node.children)
            for (const c of node.children) {
              let child = await this.get(c, stats)
              child.parent = prev.id
              await this.putNode(child, stats)
            }
            prev.vals.push(parent.vals[index - 1])
            prev.vals = concat(prev.vals, node.vals)
            prev.next = node.next || null
            if (!isNil(node.next)) {
              let next = await this.get(node.next, stats)
              next.prev = node.prev || null
              await this.putNode(next, stats)
            }
            await this.putNode(prev, stats)
            await this.rmIndex(index - 1, index, parent, stats)
            isMerged = true
          }
        }
        if (!isMerged && isNext) {
          if (!this.isOver(next, node.vals.length + 1)) {
            next.children = concat(node.children, next.children)
            for (const c of node.children) {
              let child = await this.get(c, stats)
              child.parent = next.id
              await this.putNode(child, stats)
            }
            next.vals.unshift(parent.vals[index])
            next.vals = concat(node.vals, next.vals)
            next.prev = node.prev || null
            if (!isNil(node.prev)) {
              let prev = await this.get(node.prev, stats)
              prev.next = node.next || null
              await this.putNode(prev, stats)
            }
            await this.putNode(next, stats)
            await this.rmIndex(index, index, parent, stats)
            isMerged = true
          }
        }
      } else if (node.vals.length === 0) {
        let root = null
        for (const c of node.children) {
          let child = await this.get(c, stats)
          child.parent = null
          root = c
          await this.putNode(child, stats)
        }
        if ((await this.root(stats)) === node.id) {
          this.setRoot(root, stats)
          this.del(node.id, stats)
        }
      }
    } else {
      await this.putNode(node, stats)
    }
  }

  async updateIndexes(index, node, val, changed, stats) {
    if (index === 0 && !isNil(node.parent)) {
      let parent = await this.get(node.parent, stats)
      if (isNil(parent)) return
      let parent_index = indexOf(node.id, parent.children)
      if (node.leaf) {
        if (node.vals.length > 0) {
          val = this.pick(await this.data(node.vals[0], undefined, stats))
        } else if (!isNil(node.next)) {
          let next = await this.get(node.next, stats)
          val = this.pick(await this.data(next.vals[0], undefined, stats))
        } else {
          return
        }
      }
      if (equals(val, changed) && parent_index > 0) {
        parent.vals[parent_index - 1] = val
        await this.putNode(parent, stats)
      } else if (val !== changed && parent_index > 0) {
        parent.vals[parent_index - 1] = val
        await this.putNode(parent, stats)
      } else if (parent_index === 0) {
        await this.updateIndexes(0, parent, val, changed, stats)
      }
    }
  }

  async balance(val, child_index, node, stats) {
    let merge_node = node
    let merge_child_index = child_index
    if (this.isUnder(node)) {
      if (!isNil(node.parent)) {
        let parent = await this.get(node.parent, stats)
        let index = indexOf(node.id, parent.children)
        let isMerged = false
        const isPrev = index > 0
        const isNext = index + 1 < parent.children.length
        let prev = null
        let next = null
        if (isPrev) {
          prev ??= await this.get(parent.children[index - 1], stats)
          if (!this.isUnder(prev, -1)) {
            isMerged = true
            node.vals.unshift(prev.vals.pop())
            parent.vals[index - 1] = this.pick(
              await this.data(node.vals[0], undefined, stats)
            )
            await this.putNode(prev, stats)
            await this.putNode(node, stats)
          }
        }
        if (!isMerged && isNext) {
          next ??= await this.get(parent.children[index + 1], stats)
          if (!this.isUnder(next, -1)) {
            isMerged = true
            node.vals.push(next.vals.shift())
            parent.vals[index] = this.pick(
              await this.data(next.vals[0], undefined, stats)
            )
            await this.putNode(next, stats)
            await this.putNode(node, stats)
          }
        }
        if (!isMerged && isPrev) {
          if (!this.isOver(prev, node.vals.length)) {
            prev.vals = concat(prev.vals, node.vals)
            prev.next = node.next ?? null
            if (!isNil(node.prev) && !isNil(node.next)) {
              let next = await this.get(node.next, stats)
              next.prev = node.prev
              await this.putNode(next, stats)
            }
            await this.putNode(prev, stats)
            await this.rmIndex(index - 1, index, parent, stats)
            await this.del(node.id, stats)
            isMerged = true
          }
        }
        if (!isMerged && isNext) {
          if (!this.isOver(next, node.vals.length)) {
            next.vals = concat(node.vals, next.vals)
            next.prev = node.prev ?? null
            if (!isNil(node.prev) && !isNil(node.next)) {
              let prev = await this.get(node.prev, stats)
              prev.next = node.next
              await this.putNode(prev, stats)
            }
            merge_node = next
            merge_child_index = 0
            await this.putNode(next, stats)
            await this.rmIndex(index, index, parent, stats)
            await this.del(node.id, stats)
            isMerged = true
          }
        }
        await this.putNode(parent, stats)
      } else if (node.vals.length === 0) {
        await this.setRoot(null, stats)
        await this.del(node.id, stats)
      }
    }
    await this.updateIndexes(merge_child_index, merge_node, null, val, stats)
  }

  async delete(key) {
    let stats = {}
    let [val, index, node] = await this.searchByKey(key, stats)
    if (isNil(node)) return
    node.vals = without([key], node.vals)
    await this.putNode(node, stats)
    await this.delData(key, stats)
    await this.balance(val, index, node, stats)
    await this.commit(stats)
  }

  async _insert(key, val, node, stats) {
    let index = 0
    let exists = false
    for (let v of node.vals) {
      if (this.comp(val, await this.data(v, undefined, stats)) >= 0) {
        node.vals.splice(index, 0, key)
        exists = true
        break
      }
      index += 1
    }
    if (!exists) node.vals.push(key)
  }

  async insert(key, val) {
    let stats = {}
    await this.putData(key, val, stats)
    let _val = { key, val }
    let node = await this.search(_val, undefined, stats)
    if (isNil(node)) {
      await this.init(key, stats)
    } else {
      await this._insert(key, _val, node, stats)
      await this.putNode(node, stats)
      if (this.isOver(node)) await this.split(node, stats)
    }
    await this.commit(stats)
  }

  async commit(stats) {
    for (let k in stats) {
      if (stats[k]?.__del__) {
        await this.del(k)
      } else {
        await this.put(k, stats[k])
      }
    }
    if (!isNil(this.onCommit)) this.onCommit(stats)
  }

  async splitChildren(node, new_node, stats) {
    if (!node.leaf) {
      const childrens = splitAt(node.vals.length + 1, node.children)
      node.children = childrens[0]
      new_node.children = childrens[1]
      for (const v of childrens[1]) {
        let child = await this.get(v, stats)
        child.parent = new_node.id
        await this.putNode(child, stats)
      }
    }
  }

  async _split(node, stats) {
    let nodes = splitAt(Math.ceil(node.vals.length / 2))(node.vals)
    node.vals = node.leaf ? nodes[0] : init(nodes[0])
    let new_node = {
      leaf: node.leaf,
      id: await this.id(stats),
      vals: nodes[1],
      prev: node.id,
      next: node.next ?? null,
    }
    if (!isNil(node.next)) {
      let next = await this.get(node.next, stats)
      next.prev = new_node.id
      await this.putNode(next, stats)
    }
    node.next = new_node.id
    const top = node.leaf ? nodes[1][0] : last(nodes[0])
    await this.splitChildren(node, new_node, stats)
    return [node.leaf ? await this.data(top, undefined, stats) : top, new_node]
  }

  async getParent(node, new_node, top, stats) {
    const isNewParent = isNil(node.parent)
    let parent = !isNewParent
      ? await this.get(node.parent, stats)
      : {
          leaf: false,
          id: await this.id(stats),
          vals: [top],
          children: [node.id, new_node.id],
        }
    if (!isNewParent) {
      const ind = indexOf(node.id, parent.children)
      parent.vals.splice(ind, 0, top)
      parent.children.splice(ind + 1, 0, new_node.id)
    }
    return [isNewParent, parent]
  }
  pick(obj) {
    if (typeof this.sort_fields === "string") {
      return obj.val
    } else {
      let _obj = {}
      for (let v of pluck(0)(this.sort_fields)) {
        _obj[v] = v === "__id__" ? obj.key : obj.val[v] ?? null
      }
      return _obj
    }
  }

  async split(node, stats) {
    let [top, new_node] = await this._split(node, stats)
    let [isNewParent, parent] = await this.getParent(
      node,
      new_node,
      node.leaf ? this.pick(top) : top,
      stats
    )
    new_node.parent = parent.id
    node.parent = parent.id
    await this.putNode(new_node, stats)
    await this.putNode(parent, stats)
    await this.putNode(node, stats)
    if (isNewParent) await this.setRoot(parent.id, stats)
    if (this.isOver(parent)) await this.split(parent, stats)
  }
}

module.exports = BPT
