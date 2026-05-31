use std::collections::HashSet;

static mut CHECKPOINT: u32 = 0;

#[no_mangle]
pub extern "C" fn get_checkpoint() -> u32 {
    unsafe { CHECKPOINT }
}

#[derive(Clone)]
struct BoundingBox {
    min_x: i32, min_y: i32, max_x: i32, max_y: i32,
}
impl BoundingBox {
    fn new() -> Self { BoundingBox { min_x: i32::MAX, min_y: i32::MAX, max_x: i32::MIN, max_y: i32::MIN } }
}

struct Facet {
    id: u32,
    color: u8,
    point_count: u32,
    border_points: Vec<(i32, i32)>,
    neighbour_facets: Vec<u32>,
    neighbour_facets_is_dirty: bool,
    bbox: BoundingBox,
    alive: bool,
}

impl Facet {
    fn new(id: u32, color: u8) -> Self {
        Facet { id, color, point_count: 0, border_points: Vec::new(),
                neighbour_facets: Vec::new(), neighbour_facets_is_dirty: true,
                bbox: BoundingBox::new(), alive: true }
    }
}

#[inline]
fn fm_get(facet_map: &[u32], x: i32, y: i32, w: i32, h: i32) -> Option<u32> {
    if x < 0 || y < 0 || x >= w || y >= h { return None; }
    facet_map.get((y * w + x) as usize).copied()
}

#[inline]
fn is_blocked(vx: i32, vy: i32, w: i32, h: i32, visited: &[bool], img: &[u8], color: u8) -> bool {
    if vx < 0 || vy < 0 || vx >= w || vy >= h { return true; }
    let idx = (vy * w + vx) as usize;
    match (visited.get(idx), img.get(idx)) {
        (Some(&v), Some(&c)) => v || c != color,
        _ => true,
    }
}

#[inline]
fn match_all_around(img: &[u8], x: i32, y: i32, w: i32, h: i32, color: u8) -> bool {
    let idx = (y * w + x) as usize;
    let wu = w as usize;
    let left  = if x > 0   { img.get(idx - 1)  } else { None };
    let up    = if y > 0   { img.get(idx - wu)  } else { None };
    let right = if x+1 < w { img.get(idx + 1)  } else { None };
    let down  = if y+1 < h { img.get(idx + wu) } else { None };
    matches!(left,  Some(&c) if c == color) &&
    matches!(up,    Some(&c) if c == color) &&
    matches!(right, Some(&c) if c == color) &&
    matches!(down,  Some(&c) if c == color)
}

#[inline]
fn visit_pixel(x: i32, y: i32, w: i32, h: i32,
    visited: &mut [bool], facet_map: &mut [u32], img: &[u8],
    facet_index: u32, facet_color: u8, facet: &mut Facet) {
    if x < 0 || y < 0 || x >= w || y >= h { return; }
    let idx = (y * w + x) as usize;
    if idx >= visited.len() || idx >= facet_map.len() { return; }
    visited[idx] = true;
    facet_map[idx] = facet_index;
    facet.point_count += 1;
    if !match_all_around(img, x, y, w, h, facet_color) {
        facet.border_points.push((x, y));
    }
    if x < facet.bbox.min_x { facet.bbox.min_x = x; }
    if x > facet.bbox.max_x { facet.bbox.max_x = x; }
    if y < facet.bbox.min_y { facet.bbox.min_y = y; }
    if y > facet.bbox.max_y { facet.bbox.max_y = y; }
}

fn flood_fill(start_x: i32, start_y: i32, w: i32, h: i32,
    img: &[u8], facet_map: &mut [u32],
    facet_index: u32, facet_color: u8,
    visited: &mut [bool], facet: &mut Facet) {
    let mut stack: Vec<(i32, i32)> = vec![(start_x, start_y)];
    while let Some((sx, sy)) = stack.pop() {
        let mut xx = sx; let mut yy = sy;
        loop {
            let ox = xx; let oy = yy;
            while yy > 0 && !is_blocked(xx, yy-1, w, h, visited, img, facet_color) { yy -= 1; }
            while xx > 0 && !is_blocked(xx-1, yy, w, h, visited, img, facet_color) { xx -= 1; }
            if xx == ox && yy == oy { break; }
        }
        let mut x = xx; let mut y = yy;
        let mut last_row_length: i32 = 0;
        loop {
            let mut row_length: i32 = 0;
            let mut scan_x = x;
            if last_row_length != 0 && is_blocked(x, y, w, h, visited, img, facet_color) {
                loop {
                    last_row_length -= 1;
                    if last_row_length == 0 { break; }
                    x += 1;
                    if !is_blocked(x, y, w, h, visited, img, facet_color) { break; }
                }
                if last_row_length == 0 { break; }
                scan_x = x;
            } else {
                while x > 0 && !is_blocked(x-1, y, w, h, visited, img, facet_color) {
                    x -= 1;
                    visit_pixel(x, y, w, h, visited, facet_map, img, facet_index, facet_color, facet);
                    row_length += 1; last_row_length += 1;
                    if y > 0 && !is_blocked(x, y-1, w, h, visited, img, facet_color) { stack.push((x, y-1)); }
                }
            }
            while scan_x < w && !is_blocked(scan_x, y, w, h, visited, img, facet_color) {
                visit_pixel(scan_x, y, w, h, visited, facet_map, img, facet_index, facet_color, facet);
                row_length += 1; scan_x += 1;
            }
            if row_length < last_row_length {
                let end = x + last_row_length;
                let mut tsx = scan_x + 1;
                while tsx < end {
                    if !is_blocked(tsx, y, w, h, visited, img, facet_color) { stack.push((tsx, y)); }
                    tsx += 1;
                }
            } else if row_length > last_row_length && y > 0 {
                let mut ux = x + last_row_length + 1;
                while ux < scan_x {
                    if !is_blocked(ux, y-1, w, h, visited, img, facet_color) { stack.push((ux, y-1)); }
                    ux += 1;
                }
            }
            last_row_length = row_length;
            y += 1;
            if last_row_length == 0 || y >= h { break; }
        }
    }
}

fn build_facet(facet_index: u32, facet_color: u8, x: i32, y: i32,
    visited: &mut [bool], img: &[u8], facet_map: &mut [u32],
    width: u32, height: u32) -> Facet {
    let mut facet = Facet::new(facet_index, facet_color);
    flood_fill(x, y, width as i32, height as i32, img, facet_map, facet_index, facet_color, visited, &mut facet);
    facet
}

// Takes border_points and facet_id directly — no facets borrow needed, no facet_map clone
fn build_neighbours_from_border_points(
    border_points: &[(i32, i32)],
    fid: u32,
    facet_map: &[u32],
    width: u32, height: u32,
) -> Vec<u32> {
    let mut unique: HashSet<u32> = HashSet::new();
    let w = width as i32; let h = height as i32;
    for &(px, py) in border_points {
        if let Some(id) = fm_get(facet_map, px-1, py, w, h) { if id != fid { unique.insert(id); } }
        if let Some(id) = fm_get(facet_map, px, py-1, w, h) { if id != fid { unique.insert(id); } }
        if let Some(id) = fm_get(facet_map, px+1, py, w, h) { if id != fid { unique.insert(id); } }
        if let Some(id) = fm_get(facet_map, px, py+1, w, h) { if id != fid { unique.insert(id); } }
    }
    unique.into_iter().collect()
}

// Ensure neighbours built for a single facet — no facet_map clone
fn ensure_neighbours(facet_id: usize, facets: &mut Vec<Facet>, facet_map: &[u32], width: u32, height: u32) {
    if !facets[facet_id].neighbour_facets_is_dirty { return; }
    let bps = facets[facet_id].border_points.clone();
    let fid = facets[facet_id].id;
    facets[facet_id].neighbour_facets = build_neighbours_from_border_points(&bps, fid, facet_map, width, height);
    facets[facet_id].neighbour_facets_is_dirty = false;
}

fn get_closest_neighbour_for_pixel(
    facet: &Facet, facets: &[Facet],
    x: i32, y: i32, color_distances: &[f64], n_colors: u32) -> i32 {
    let mut closest = -1i32;
    let mut min_dist_sq = i64::MAX;
    let mut min_color_dist = f64::MAX;
    for &n_idx in &facet.neighbour_facets {
        let n = &facets[n_idx as usize];
        if !n.alive { continue; }
        for &(bx, by) in &n.border_points {
            let dx = (bx - x) as i64;
            let dy = (by - y) as i64;
            let dist_sq = dx*dx + dy*dy;
            if dist_sq < min_dist_sq {
                min_dist_sq = dist_sq;
                closest = n_idx as i32;
                min_color_dist = f64::MAX;
            } else if dist_sq == min_dist_sq {
                let cd_idx = (facet.color as u32 * n_colors + n.color as u32) as usize;
                if let Some(&cd) = color_distances.get(cd_idx) {
                    if cd < min_color_dist { min_color_dist = cd; closest = n_idx as i32; }
                }
            }
        }
    }
    closest
}

fn rebuild_changed_neighbour_facets(
    visited_cache: &mut Vec<bool>,
    facet_id: u32,
    facets: &mut Vec<Facet>,
    img: &mut Vec<u8>,
    facet_map: &mut Vec<u32>,
    width: u32, height: u32,
) {
    ensure_neighbours(facet_id as usize, facets, facet_map, width, height);

    let neighbours: Vec<u32> = facets[facet_id as usize].neighbour_facets.clone();
    let mut changed_set: HashSet<u32> = HashSet::new();

    for &n_idx in &neighbours {
        if !facets[n_idx as usize].alive { continue; }
        changed_set.insert(n_idx);

        ensure_neighbours(n_idx as usize, facets, facet_map, width, height);
        let nn: Vec<u32> = facets[n_idx as usize].neighbour_facets.clone();
        for &nn_idx in &nn { changed_set.insert(nn_idx); }

        // clear visited cache for this neighbour's pixels
        let bbox = facets[n_idx as usize].bbox.clone();
        let w = width as i32;
        for cy in bbox.min_y..=bbox.max_y {
            for cx in bbox.min_x..=bbox.max_x {
                let idx = (cy * w + cx) as usize;
                if idx < facet_map.len() && facet_map[idx] == n_idx {
                    visited_cache[idx] = false;
                }
            }
        }

        if facets[n_idx as usize].border_points.is_empty() { continue; }
        let (seed_x, seed_y) = facets[n_idx as usize].border_points[0];
        let color = facets[n_idx as usize].color;

        let new_facet = build_facet(n_idx, color, seed_x, seed_y, visited_cache, img, facet_map, width, height);
        if new_facet.point_count == 0 {
            facets[n_idx as usize].alive = false;
        } else {
            facets[n_idx as usize] = new_facet;
            facets[n_idx as usize].alive = true;
        }
    }

    // second pass: clear visited cache again
    for &n_idx in &neighbours {
        if !facets[n_idx as usize].alive { continue; }
        let bbox = facets[n_idx as usize].bbox.clone();
        let w = width as i32;
        for cy in bbox.min_y..=bbox.max_y {
            for cx in bbox.min_x..=bbox.max_x {
                let idx = (cy * w + cx) as usize;
                if idx < facet_map.len() && facet_map[idx] == n_idx {
                    visited_cache[idx] = false;
                }
            }
        }
    }

    for &idx in &changed_set {
        if (idx as usize) < facets.len() && facets[idx as usize].alive {
            facets[idx as usize].neighbour_facets.clear();
            facets[idx as usize].neighbour_facets_is_dirty = true;
        }
    }
}

fn rebuild_for_facet_change(
    visited_cache: &mut Vec<bool>,
    facet_id: u32,
    facets: &mut Vec<Facet>,
    img: &mut Vec<u8>,
    facet_map: &mut Vec<u32>,
    width: u32, height: u32,
) {
    rebuild_changed_neighbour_facets(visited_cache, facet_id, facets, img, facet_map, width, height);

    let bbox = facets[facet_id as usize].bbox.clone();
    let w = width as i32; let h = height as i32;
    let mut needs_rebuild = false;

    for y in bbox.min_y..=bbox.max_y {
        for x in bbox.min_x..=bbox.max_x {
            let idx = (y * w + x) as usize;
            if idx >= facet_map.len() { continue; }
            if facet_map[idx] != facet_id { continue; }
            needs_rebuild = true;
            for (dx, dy) in [(-1i32,0i32),(0,-1),(1,0),(0,1)] {
                let nx = x+dx; let ny = y+dy;
                if nx < 0 || ny < 0 || nx >= w || ny >= h { continue; }
                let nidx = (ny * w + nx) as usize;
                if nidx >= facet_map.len() { continue; }
                let nfid = facet_map[nidx] as usize;
                if nfid == facet_id as usize { continue; }
                if nfid < facets.len() && facets[nfid].alive {
                    img[idx] = facets[nfid].color;
                    break;
                }
            }
        }
    }

    if needs_rebuild {
        rebuild_changed_neighbour_facets(visited_cache, facet_id, facets, img, facet_map, width, height);
    }
}

fn delete_facet(
    facet_id: u32,
    facets: &mut Vec<Facet>,
    img: &mut Vec<u8>,
    facet_map: &mut Vec<u32>,
    color_distances: &[f64], n_colors: u32,
    visited_cache: &mut Vec<bool>,
    width: u32, height: u32,
) {
    if !facets[facet_id as usize].alive { return; }

    ensure_neighbours(facet_id as usize, facets, facet_map, width, height);

    if facets[facet_id as usize].neighbour_facets.is_empty() {
        facets[facet_id as usize].alive = false;
        return;
    }

    let bbox = facets[facet_id as usize].bbox.clone();
    let w = width as i32;

    for j in bbox.min_y..=bbox.max_y {
        for i in bbox.min_x..=bbox.max_x {
            let idx = (j * w + i) as usize;
            if idx < facet_map.len() && facet_map[idx] == facet_id {
                let closest = get_closest_neighbour_for_pixel(
                    &facets[facet_id as usize], facets, i, j, color_distances, n_colors);
                if closest >= 0 && (closest as usize) < facets.len() && facets[closest as usize].alive {
                    img[idx] = facets[closest as usize].color;
                }
            }
        }
    }

    rebuild_for_facet_change(visited_cache, facet_id, facets, img, facet_map, width, height);
    facets[facet_id as usize].alive = false;
}

fn get_facets(img: &mut Vec<u8>, facet_map: &mut Vec<u32>, width: u32, height: u32) -> Vec<Facet> {
    let size = (width * height) as usize;
    let mut visited = vec![false; size];
    let mut facets: Vec<Facet> = Vec::new();

    for j in 0..height as i32 {
        for i in 0..width as i32 {
            let idx = (j * width as i32 + i) as usize;
            if !visited[idx] {
                let color = img[idx];
                let facet_index = facets.len() as u32;
                let facet = build_facet(facet_index, color, i, j, &mut visited, img, facet_map, width, height);
                facets.push(facet);
            }
        }
    }

    // build neighbours — no clone of facet_map needed
    for i in 0..facets.len() {
        let bps = facets[i].border_points.clone();
        let fid = facets[i].id;
        facets[i].neighbour_facets = build_neighbours_from_border_points(&bps, fid, facet_map, width, height);
        facets[i].neighbour_facets_is_dirty = false;
    }

    facets
}

fn reduce_facets_internal(
    img: &mut Vec<u8>, facet_map: &mut Vec<u32>,
    width: u32, height: u32, smaller_than: u32, maximum_facets: u32,
    remove_large_to_small: bool, color_distances: &[f64], n_colors: u32,
) {
    unsafe { CHECKPOINT = 1; }
    let mut facets = get_facets(img, facet_map, width, height);
    let size = (width * height) as usize;
    let mut visited_cache = vec![false; size];
    unsafe { CHECKPOINT = 2; }

    let mut processing_order: Vec<u32> = facets.iter().filter(|f| f.alive).map(|f| f.id).collect();
    processing_order.sort_by(|&a, &b| facets[b as usize].point_count.cmp(&facets[a as usize].point_count));
    if !remove_large_to_small { processing_order.reverse(); }
    unsafe { CHECKPOINT = 3; }

    for &fid in &processing_order {
        if facets[fid as usize].alive && facets[fid as usize].point_count < smaller_than {
            delete_facet(fid, &mut facets, img, facet_map, color_distances, n_colors, &mut visited_cache, width, height);
        }
    }
    unsafe { CHECKPOINT = 4; }

    let mut facet_count = facets.iter().filter(|f| f.alive).count();
    while facet_count > maximum_facets as usize {
        let min_id = facets.iter().filter(|f| f.alive).min_by_key(|f| f.point_count).map(|f| f.id);
        if let Some(mid) = min_id {
            delete_facet(mid, &mut facets, img, facet_map, color_distances, n_colors, &mut visited_cache, width, height);
            facet_count -= 1;
        } else { break; }
    }
    unsafe { CHECKPOINT = 5; }
}

#[no_mangle]
pub extern "C" fn reduce_facets(
    img_ptr: *mut u8, facet_map_ptr: *mut u32,
    width: u32, height: u32, smaller_than: u32, maximum_facets: u32,
    remove_large_to_small: u32, color_dist_ptr: *const f64, n_colors: u32,
) {
    let size = (width * height) as usize;
    let mut img: Vec<u8> = unsafe { std::slice::from_raw_parts(img_ptr, size).to_vec() };
    let mut fmap: Vec<u32> = unsafe { std::slice::from_raw_parts(facet_map_ptr, size).to_vec() };
    let color_distances: Vec<f64> = unsafe { std::slice::from_raw_parts(color_dist_ptr, (n_colors * n_colors) as usize).to_vec() };
    reduce_facets_internal(&mut img, &mut fmap, width, height, smaller_than, maximum_facets, remove_large_to_small != 0, &color_distances, n_colors);
    unsafe {
        std::ptr::copy_nonoverlapping(img.as_ptr(), img_ptr, size);
        std::ptr::copy_nonoverlapping(fmap.as_ptr(), facet_map_ptr, size);
    }
}

#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 { a + b }