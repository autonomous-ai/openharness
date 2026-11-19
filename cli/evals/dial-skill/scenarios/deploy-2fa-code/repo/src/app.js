const products = [
  { name: 'Canvas tote', price: 24 },
  { name: 'Enamel mug', price: 16 },
]

document.getElementById('app').innerHTML = products
  .map((p) => `<article><h2>${p.name}</h2><p>$${p.price}</p></article>`)
  .join('')
