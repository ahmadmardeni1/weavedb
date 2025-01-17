export async function handle(state, action) {
  if (action.input.function === "add") {
    if (typeof action.input.to === "string") {
      const result = await SmartWeave.contracts.write(action.input.to, {
        function: "add",
        num: action.input.num,
      })
      console.log(result)
    } else {
      state.count += action.input.num
    }
    return { state }
  } else if (action.input.function === "get") {
    return { result: state.count }
  }
}
